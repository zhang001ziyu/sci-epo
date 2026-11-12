"""Offline tests of the session mode: a fake Sci-epo session server and a fake ComfyUI on localhost, no GPU.
Tests that make or measure real clips need ffmpeg (on PATH, or $SCIEPO_FFMPEG) and are skipped without it.

Run from the repository root:  python -m unittest discover -s worker/tests -v
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sciepo_worker as w  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
TOKEN = 'sciepo_ss_' + ('Ab3_-xY9z' * 5)[:43]
OTHER_TOKEN = 'sciepo_wk_' + 'Q' * 30
CODE = '#' + TOKEN  # the server origin is put in front by FakeSession
PNG = b'\x89PNG\r\n\x1a\n' + bytes(range(32))
PNG_SHA = hashlib.sha256(PNG).hexdigest()
REF_NAME = f'maya-{PNG_SHA[:8]}.png'
GPU = ('NVIDIA RTX PRO 6000 Blackwell Server Edition', 95.6)
HAS_FFMPEG = bool(w.find_tool('ffmpeg') and w.find_tool('ffprobe'))
FAKE_VIDEO = b'\x00\x00\x00\x18ftypmp42fake-h3-take'


def stack_document() -> dict:
    """The h3-lite profile with its workflow graphs, as Sci-epo's session document carries it."""
    profile = json.loads((ROOT / 'worker' / 'stacks' / 'h3-lite.json').read_text(encoding='utf-8'))
    graphs = {mode: json.loads((ROOT / 'worker' / 'stacks' / name).read_text(encoding='utf-8')) for mode, name in profile['workflows'].items()}
    return {**profile, 'workflowGraphs': graphs}


def make_take(n: int = 1, job: str = 'job-0001-aaaa', **overrides) -> dict:
    take = {'jobId': job, 'n': n, 'seed': 4100 + n, 'leaseExpiresAt': '2026-11-12T08:15:00.000Z', 'batchId': 'batch-1', 'clipId': 'c01',
            'languages': ['en'], 'mode': 'r2v', 'prompt': 'integrated_multimodal_description: <Picture 1> MAYA at the door. <d>[MAYA] Last order.</d>',
            'frames': 48, 'seconds': 2.0, 'width': 480, 'height': 864, 'fps': 24, 'steps': 20, 'turbo': False,
            'stack': {'id': 'h3-lite', 'version': '2026.11.1'}, 'images': [REF_NAME], 'audio': [], 'output': 'ep01-c01.mp4',
            'shots': [{'shotId': 's1', 'start': 0, 'end': 1.0}, {'shotId': 's2', 'start': 1.0, 'end': 2.0}],
            'expectedLines': [{'sceneId': 'sc1', 'position': 2, 'language': 'en', 'text': 'Last order.'}], 'rehearsal': False}
    take.update(overrides)
    return take


class FakeSession:
    """Sci-epo's worker session routes: the document, references, events, claim, heartbeat, file uploads, result and end."""

    def __init__(self, answers, *, mode='pull', stacks=None, modes=('r2v',), references=None, blobs=None, allow_untested=False,
                 heartbeat=0.05, upload_failures=None, always_fail=(), on_claim=None, budget_ends='2099-01-01T00:00:00.000Z',
                 storage=None, work=None, music=None, cut_args=None):
        self.answers, self.budget_ends = list(answers), budget_ends
        # Drive storage: the document's storage and work, the music of the cuts and Sci-epo's ffmpeg arguments (a function
        # of the cut id and the request body).
        self.storage, self.work, self.music, self.cut_args = storage, work, music, cut_args
        self.cut_heartbeats, self.args_calls, self.cut_results, self.music_gets = [], [], {}, 0
        self.mode, self.modes, self.allow_untested, self.heartbeat_s = mode, list(modes), allow_untested, heartbeat
        self.stacks = [stack_document()] if stacks is None and mode == 'pull' else list(stacks or [])
        self.references = [{'name': REF_NAME, 'sha256': PNG_SHA, 'kind': 'image', 'bytes': len(PNG)}] if references is None else references
        self.blobs = {PNG_SHA: PNG} if blobs is None else blobs
        self.upload_failures = {kind: list(codes) for kind, codes in (upload_failures or {}).items()}
        self.always_fail, self.on_claim = set(always_fail), on_claim
        self.events, self.heartbeats, self.uploads, self.results, self.ends = [], [], [], {}, []
        self.claims, self.stop, self.current, self.origins, self.unauthorized = 0, None, True, [], 0
        self.lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def reply(self, status, payload=None, raw=None):
                body = raw if raw is not None else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def route(self):
                if self.headers.get('origin'):
                    outer.origins.append(self.headers['origin'])
                if self.headers.get('authorization') != f'Bearer {TOKEN}':
                    outer.unauthorized += 1
                    self.reply(401, {'error': 'bad token'})
                    return None
                url = urllib.parse.urlsplit(self.path)
                parts = url.path.split('/')[4:] if url.path.startswith('/api/worker/v1/') else []
                return parts, urllib.parse.parse_qs(url.query)

            def body(self):
                return self.rfile.read(int(self.headers.get('content-length') or 0))

            def do_GET(self):  # noqa: N802
                found = self.route()
                if found is None:
                    return None
                parts, _ = found
                if parts == ['session']:
                    return self.reply(200, outer.document())
                if len(parts) == 2 and parts[0] == 'references':
                    blob = outer.blobs.get(parts[1])
                    return self.reply(200, raw=blob) if blob is not None else self.reply(404, {'error': 'no such reference'})
                if len(parts) == 3 and parts[0] == 'cuts' and parts[2] == 'music':
                    outer.music_gets += 1
                    return self.reply(200, raw=outer.music) if outer.music is not None else self.reply(404, {'error': 'no music'})
                return self.reply(404, {'error': 'not found'})

            def do_POST(self):  # noqa: N802
                found = self.route()
                if found is None:
                    return None
                parts, _ = found
                raw = self.body()
                payload = json.loads(raw) if raw else {}
                with outer.lock:
                    if parts == ['session', 'events']:
                        outer.events.append(payload)
                        return self.reply(200, {'ok': True, 'stop': outer.stop})
                    if parts == ['session', 'claim']:
                        outer.claims += 1
                        if outer.on_claim:
                            outer.on_claim(outer)
                        return self.reply(200, outer.answers.pop(0) if outer.answers else {'end': 'queue_empty'})
                    if parts == ['session', 'end']:
                        outer.ends.append(payload)
                        return self.reply(200, {'ok': True})
                    if len(parts) == 4 and parts[0] == 'takes' and parts[3] == 'heartbeat':
                        outer.heartbeats.append((parts[1], int(parts[2])))
                        return self.reply(200, {'leaseExpiresAt': '2026-11-12T08:30:00.000Z', 'stop': outer.stop, 'current': outer.current,
                                                'budgetEndsAt': outer.budget_ends})
                    if len(parts) == 4 and parts[0] == 'takes' and parts[3] == 'result':
                        outer.results[(parts[1], int(parts[2]))] = payload
                        return self.reply(200, {'ok': True})
                    if len(parts) == 3 and parts[0] == 'cuts' and parts[2] == 'heartbeat':
                        outer.cut_heartbeats.append(parts[1])
                        return self.reply(200, {'stop': outer.stop})
                    if len(parts) == 3 and parts[0] == 'cuts' and parts[2] == 'result':
                        outer.cut_results[parts[1]] = payload
                        return self.reply(200, {'ok': True})
                    if len(parts) == 3 and parts[0] == 'cuts' and parts[2] == 'args':
                        outer.args_calls.append((parts[1], payload))
                        make = outer.cut_args
                if len(parts) == 3 and parts[0] == 'cuts' and parts[2] == 'args':  # outside the lock: it may change outer.stop
                    return self.reply(200, make(parts[1], payload)) if make else self.reply(404, {'error': 'no cut'})
                return self.reply(404, {'error': 'not found'})

            def do_PUT(self):  # noqa: N802
                found = self.route()
                if found is None:
                    return None
                parts, query = found
                data = self.body()
                if not (len(parts) == 5 and parts[0] == 'takes' and parts[3] == 'files'):
                    return self.reply(404, {'error': 'not found'})
                kind = parts[4]
                with outer.lock:
                    record = {'jobId': parts[1], 'n': int(parts[2]), 'kind': kind, 'shot': (query.get('shot') or [None])[0], 'bytes': data,
                              'length': self.headers.get('content-length'), 'type': self.headers.get('content-type')}
                    if kind == 'video' and (outer.storage or {}).get('video') == 'drive':  # videos go to Google Drive
                        outer.uploads.append({**record, 'status': 409})
                        return self.reply(409, {'error': 'videos of this session go to Google Drive'})
                    queued = outer.upload_failures.get(kind)
                    if kind in outer.always_fail or queued:
                        status = queued.pop(0) if queued else 503
                        outer.uploads.append({**record, 'status': status})
                        return self.reply(status, {'error': 'try later'})
                    asset = f'asset-{len(outer.uploads) + 1}'
                    outer.uploads.append({**record, 'status': 200, 'assetId': asset})
                return self.reply(200, {'assetId': asset, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})

            def log_message(self, *args):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.code = self.url + CODE
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def document(self) -> dict:
        return {'format': 'sciepo-session', 'version': 1,
                'session': {'id': 'session-1', 'mode': self.mode, 'expiresAt': '2099-01-01T00:00:00.000Z', 'startedAt': '2026-11-12T08:00:00.000Z',
                            'budgetMinutes': 60, 'budgetEndsAt': self.budget_ends, 'allowUntestedGpu': self.allow_untested,
                            'waitForRetakesMinutes': 0, 'heartbeatSeconds': self.heartbeat_s},
                'worker': {'sha256': w.program_sha256(), 'bytes': 1}, 'stacks': self.stacks, 'modes': self.modes, 'references': self.references,
                'estimate': {'setupMinutes': 0, 'renderMinutes': 1, 'takes': len(self.answers), 'frames': 96, 'measured': False},
                **({'storage': self.storage} if self.storage is not None else {}), **({'work': self.work} if self.work is not None else {})}

    def stages(self) -> list[str]:
        return [e['stage'] for e in self.events]

    def uploaded(self, kind: str, ok: bool = True) -> list[dict]:
        return [u for u in self.uploads if u['kind'] == kind and (u['status'] == 200) == ok]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


REQUIRED = stack_document()['requiredNodes']['r2v']


class SessionComfy:
    """ComfyUI for sessions: /system_stats, /object_info, /upload/image, /prompt, /history, /view and /interrupt."""

    def __init__(self, video=FAKE_VIDEO, nodes=tuple(REQUIRED), fail=False, hang=False, message='CUDA out of memory', on_prompt=None):
        self.video, self.nodes, self.fail, self.hang, self.message, self.on_prompt = video, list(nodes), fail, hang, message, on_prompt
        self.graphs, self.uploads, self.interrupts = [], [], 0
        self.interrupted = threading.Event()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def reply(self, status, payload=None, raw=None):
                body = raw if raw is not None else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802
                if self.path == '/system_stats':
                    return self.reply(200, {'system': {'comfyui_version': 'test'}})
                if self.path == '/object_info':
                    return self.reply(200, {name: {} for name in outer.nodes})
                if self.path.startswith('/history/'):
                    pid = self.path.rsplit('/', 1)[1]
                    if outer.interrupted.is_set():
                        return self.reply(200, {pid: {'status': {'status_str': 'error', 'completed': False, 'messages': [['execution_interrupted', {}]]}, 'outputs': {}}})
                    if outer.hang:
                        return self.reply(200, {})
                    if outer.fail:
                        return self.reply(200, {pid: {'status': {'status_str': 'error', 'completed': False,
                                                                 'messages': [['execution_error', {'exception_message': outer.message}]]}, 'outputs': {}}})
                    return self.reply(200, {pid: {'status': {'status_str': 'success', 'completed': True},
                                                  'outputs': {'15': {'images': [{'filename': f'h3_{pid}.mp4', 'subfolder': 'sciepo', 'type': 'output'}]}}}})
                if self.path.startswith('/view?'):
                    return self.reply(200, raw=outer.video)
                return self.reply(404, {})

            def do_POST(self):  # noqa: N802
                body = self.rfile.read(int(self.headers.get('content-length') or 0))
                if self.path == '/upload/image':
                    name = body.split(b'filename="')[1].split(b'"')[0].decode()
                    outer.uploads.append(name)
                    return self.reply(200, {'name': name, 'subfolder': '', 'type': 'input'})
                if self.path == '/prompt':
                    outer.graphs.append(json.loads(body)['prompt'])
                    if outer.on_prompt:
                        outer.on_prompt(outer)
                    return self.reply(200, {'prompt_id': f'p{len(outer.graphs)}', 'number': len(outer.graphs)})
                if self.path == '/interrupt':
                    outer.interrupts += 1
                    outer.interrupted.set()
                    return self.reply(200, None, b'')
                return self.reply(404, {})

            def log_message(self, *args):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class SessionTestCase(unittest.TestCase):
    real_video = FAKE_VIDEO

    @classmethod
    def setUpClass(cls):
        if HAS_FFMPEG:  # a real 2-second clip of the planned size, so QA has something to measure
            folder = Path(tempfile.mkdtemp(prefix='sciepo-video-'))
            cls.real_video = w.render_rehearsal(make_take(), folder / 'clip.mp4').read_bytes()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.gpu = mock.patch.object(w, 'query_gpu', return_value=GPU)
        self.query_gpu = self.gpu.start()
        for name, value in (('transcribe', mock.Mock(return_value=None)), ('COMFY_POLL_S', 0.01), ('UPLOAD_BACKOFF_S', 0.01)):
            patcher = mock.patch.object(w, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.gpu.stop)
        self.servers = []

    def tearDown(self):
        for server in self.servers:
            server.close()
        self.tmp.cleanup()

    def serve(self, server):
        self.servers.append(server)
        return server

    def run_session(self, fake: FakeSession, comfy: SessionComfy | None = None, code: str | None = None) -> tuple[int, str]:
        argv = ['session', '--work-dir', str(self.dir / 'work'), '--comfy-dir', str(self.dir / 'comfy')]
        if comfy is not None:
            argv += ['--comfy-url', comfy.url, '--skip-setup']
        out = io.StringIO()
        with mock.patch.dict(os.environ, {'SCIEPO_SESSION': code or fake.code}), contextlib.redirect_stdout(out):
            exit_code = w.main(argv)
        printed = out.getvalue()
        self.assertNotIn(TOKEN, printed)
        self.assertEqual(fake.origins, [])
        return exit_code, printed


class SessionHelperTests(unittest.TestCase):
    def test_session_codes_are_checked_before_anything_is_sent(self):
        self.assertEqual(w.parse_session_code(f'https://studio.example.com#{TOKEN}'), ('https://studio.example.com', TOKEN))
        self.assertEqual(w.parse_session_code(f' http://127.0.0.1:4317/#{TOKEN}\n'), ('http://127.0.0.1:4317', TOKEN))
        for bad in (f'http://studio.example.com#{TOKEN}', f'https://studio.example.com#{OTHER_TOKEN}', TOKEN, f'https://studio.example.com#{TOKEN}x',
                    f'ftp://studio.example.com#{TOKEN}', f'https://user:pw@studio.example.com#{TOKEN}', ''):
            with self.assertRaises(w.WorkerError, msg=bad):
                w.parse_session_code(bad)
        out = io.StringIO()
        with mock.patch.dict(os.environ, {'SCIEPO_SESSION': f'http://studio.example.com#{TOKEN}'}), contextlib.redirect_stdout(out):
            self.assertEqual(w.main(['session']), 3)
        self.assertIn('https', out.getvalue())
        self.assertNotIn(TOKEN, out.getvalue())

    def test_tokens_are_scrubbed_from_text(self):
        self.assertEqual(w.scrub(f'a {TOKEN} b {OTHER_TOKEN}.'), 'a [token] b [token].')
        self.assertEqual(w.scrub('sciepo_ss_short and sciepo_xx_' + 'a' * 30), 'sciepo_ss_short and sciepo_xx_' + 'a' * 30)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            w.log(f'token {TOKEN}')
        self.assertEqual(out.getvalue().strip(), '[sciepo-worker] token [token]')

    def test_gpu_line_and_the_tested_gpus_of_a_stack(self):
        self.assertEqual(w.parse_gpu_line('NVIDIA RTX PRO 6000 Blackwell Server Edition, 97887\nTesla T4, 15360\n'), GPU)
        self.assertIsNone(w.parse_gpu_line('No devices were found'))
        stacks = [stack_document()]
        self.assertEqual(w.untested_gpu(stacks, ['r2v'], *GPU), [])
        self.assertEqual(w.untested_gpu(stacks, ['r2v'], 'Tesla T4', 15.0), ['h3-lite r2v'])
        self.assertEqual(w.untested_gpu(stacks, ['r2v'], GPU[0], 80.0), ['h3-lite r2v'])
        self.assertEqual(w.untested_gpu(stacks, ['r2v', 't2va'], *GPU), ['h3-lite t2va'])

    def test_line_scores_fold_case_punctuation_and_width_and_join_segments(self):
        segments = [{'start': 0.0, 'end': 1.2, 'text': '你好，我在这里'}, {'start': 1.3, 'end': 2.0, 'text': 'Last order'},
                    {'start': 2.0, 'end': 3.1, 'text': 'of the night.'}, {'start': 3.2, 'end': 4.0, 'text': 'ok, let\'s go'}]
        expected = [{'sceneId': 'sc1', 'position': 1, 'language': 'zh-CN', 'text': '你好，我在这里。'},
                    {'sceneId': 'sc1', 'position': 2, 'language': 'en', 'text': 'LAST ORDER of the night!'},
                    {'sceneId': 'sc1', 'position': 3, 'language': 'en', 'text': 'ＯＫ，Ｌｅｔ＇ｓ　ｇｏ！'},
                    {'sceneId': 'sc2', 'position': 4, 'language': 'en', 'text': 'Completely unrelated words appear here instead'},
                    {'sceneId': 'sc2', 'position': 5, 'language': 'en', 'text': 'Last order of the day'}]
        lines = w.score_lines(expected, segments)
        self.assertEqual([line['score'] for line in lines[:3]], [1.0, 1.0, 1.0])
        self.assertEqual(lines[0]['heard'], '你好，我在这里')
        self.assertEqual(lines[1]['heard'], 'Last order of the night.')
        self.assertEqual(lines[1]['language'], 'en')
        self.assertEqual((lines[3]['score'], w.line_status(lines[3]['score'])), (0.0, 'failure'))
        self.assertEqual((lines[4]['score'], w.line_status(lines[4]['score'])), (0.8, 'pass'))
        self.assertEqual([w.line_status(s) for s in (0.59, 0.2, 0.19)], ['warning', 'warning', 'failure'])
        self.assertEqual(w.score_lines(expected[:1], [])[0], {'sceneId': 'sc1', 'position': 1, 'language': 'zh-CN', 'expected': '你好，我在这里。', 'heard': '', 'score': 0.0})
        self.assertEqual(w.speech_tokens('Ｈｅｌｌｏ, World!', False), ['hello', 'world'])
        self.assertEqual(w.speech_tokens('你好，世界！', True), ['你', '好', '世', '界'])

    def test_comfyui_backend_sets_steps_and_lora_strength_for_session_takes(self):
        comfy = SessionComfy()
        try:
            folder = Path(tempfile.mkdtemp(prefix='sciepo-refs-'))
            (folder / REF_NAME).write_bytes(PNG)
            backend = w.ComfyUIBackend(comfy.url, stack_document()['workflowGraphs'], folder, timeout_s=30, poll_s=0.01)
            base = {'id': 'j-t1', 'mode': 'r2v', 'prompt': 'p', 'frames': 48, 'width': 480, 'height': 864, 'seed': 9, 'images': [REF_NAME], 'audio': [], 'output': 'c-t1.mp4'}
            backend.render({**base, 'steps': 4, 'turbo': True}, folder / 'out')
            backend.render({**base, 'steps': 20, 'turbo': False}, folder / 'out')
            self.assertEqual([(g['9']['inputs']['steps'], g['2']['inputs']['strength_model']) for g in comfy.graphs], [(4, 1.0), (20, 0.0)])
            with self.assertRaisesRegex(w.WorkerError, r'\{\{(STEPS|LORA_STRENGTH)\}\}'):  # a version 1 job has no steps for a stack workflow
                backend.render(base, folder / 'out')
        finally:
            comfy.close()


class SessionFlowTests(SessionTestCase):
    @unittest.skipUnless(HAS_FFMPEG, 'ffmpeg and ffprobe are needed for rehearsal renders')
    def test_rehearsal_session_renders_checks_and_uploads_placeholder_takes(self):
        zh = make_take(1, 'job-0002-bbbb', output='ep01-c02-zh-CN.mp4', languages=['zh-CN'], images=[],
                       expectedLines=[{'sceneId': 'sc2', 'position': 1, 'language': 'zh-CN', 'text': '最后一单：你确定吗？'}])
        fake = self.serve(FakeSession([{'take': make_take(rehearsal=True)}, {'wait': 0.05}, {'take': zh}], mode='rehearsal', modes=['r2v']))
        code, printed = self.run_session(fake)
        self.assertEqual(code, 0, printed)
        stages = fake.stages()
        self.assertEqual(stages[0], 'connected')
        self.assertEqual(fake.events[0]['data']['workerSha256'], hashlib.sha256((ROOT / 'worker' / 'sciepo_worker.py').read_bytes()).hexdigest())
        self.assertEqual(stages[-1], 'finishing')
        self.assertFalse({'gpu', 'installing', 'downloading', 'starting_comfyui', 'error'} & set(stages))
        self.assertEqual([s for s in stages if s in ('rendering', 'checking', 'uploading')], ['rendering', 'checking', 'uploading'] * 2)
        self.query_gpu.assert_not_called()
        self.assertEqual((self.dir / 'work' / 'refs' / REF_NAME).read_bytes(), PNG)
        self.assertEqual(fake.claims, 4)
        videos = fake.uploaded('video')
        self.assertEqual(len(videos), 2)
        self.assertNotEqual(videos[0]['bytes'], videos[1]['bytes'])
        for upload in fake.uploads:
            self.assertEqual(int(upload['length']), len(upload['bytes']))
        self.assertTrue(all(v['bytes'][4:8] == b'ftyp' and v['type'] == 'video/mp4' for v in videos))
        self.assertTrue(all(u['bytes'][:3] == b'\xff\xd8\xff' for u in fake.uploads if u['kind'] in ('contact-sheet', 'keyframe')))
        self.assertEqual(sorted((u['jobId'], u['shot']) for u in fake.uploaded('keyframe')),
                         [('job-0001-aaaa', 's1'), ('job-0001-aaaa', 's2'), ('job-0002-bbbb', 's1'), ('job-0002-bbbb', 's2')])
        data = json.loads(fake.uploaded('qa')[0]['bytes'])
        self.assertEqual((data['format'], data['session']['id'], data['take']['jobId']), ('sciepo-take-qa', 'session-1', 'job-0001-aaaa'))
        probe = self.dir / 'probe.mp4'
        probe.write_bytes(videos[1]['bytes'])
        info = w.ffprobe_info(probe)
        video = next(s for s in info['streams'] if s['codec_type'] == 'video')
        self.assertEqual((video['width'], video['height'], video['codec_name'], video['pix_fmt'], int(video['nb_frames'])), (480, 864, 'h264', 'yuv420p', 48))
        self.assertTrue(any(s['codec_type'] == 'audio' and s['codec_name'] == 'aac' for s in info['streams']))
        result = fake.results[('job-0001-aaaa', 1)]
        self.assertEqual(result['status'], 'rendered')
        assets = {u['assetId']: u for u in fake.uploads if u['status'] == 200}
        self.assertEqual(assets[result['files']['video']]['kind'], 'video')
        self.assertEqual(assets[result['files']['contactSheet']]['kind'], 'contact-sheet')
        self.assertEqual(assets[result['files']['qa']]['kind'], 'qa')
        self.assertEqual([k['shotId'] for k in result['files']['keyframes']], ['s1', 's2'])
        self.assertEqual([(c['id'], c['status']) for c in result['qa']['checks']],
                         [(i, 'pass') for i in ('duration', 'size', 'frame_rate', 'audio', 'loudness', 'silence')])
        self.assertEqual(set(result['qa']['loudness']), {'integrated', 'truePeak', 'range'})
        self.assertAlmostEqual(result['seconds'], 2.0, places=2)
        self.assertGreaterEqual(result['timing']['renderSeconds'], 0)
        self.assertEqual(fake.ends[0]['reason'], 'queue_empty')
        self.assertEqual(fake.ends[0]['undelivered'], [])
        self.assertIn('2 rendered', fake.ends[0]['summary']['message'])

    def test_pull_session_with_a_running_comfyui(self):
        comfy = self.serve(SessionComfy(video=self.real_video))
        turbo = make_take(1, 'job-0002-bbbb', output='ep01-c02.mp4', steps=4, turbo=True, seed=77)
        fake = self.serve(FakeSession([{'take': make_take()}, {'take': turbo}]))
        code, printed = self.run_session(fake, comfy)
        self.assertEqual(code, 0, printed)
        stages = fake.stages()
        self.assertFalse({'installing', 'downloading', 'starting_comfyui', 'error'} & set(stages))
        gpu = next(e for e in fake.events if e['stage'] == 'gpu')
        self.assertEqual(gpu['data'], {'gpu': GPU[0], 'vramGb': GPU[1]})
        self.assertLess(stages.index('gpu'), stages.index('ready'))
        self.assertEqual((self.dir / 'work' / 'refs' / REF_NAME).read_bytes(), PNG)
        self.assertEqual(comfy.uploads, [REF_NAME, REF_NAME])
        first, second = comfy.graphs
        self.assertEqual((first['9']['inputs']['steps'], first['2']['inputs']['strength_model'], first['7']['inputs']['noise_seed']), (20, 0.0, 4101))
        self.assertEqual((second['9']['inputs']['steps'], second['2']['inputs']['strength_model'], second['7']['inputs']['noise_seed']), (4, 1.0, 77))
        self.assertEqual(first['20']['inputs']['image'], REF_NAME)
        self.assertNotIn('21', first)
        self.assertNotIn('30', first)
        self.assertEqual((first['6']['inputs']['width'], first['6']['inputs']['height'], first['6']['inputs']['length']), (480, 864, 48))
        self.assertEqual(first['15']['inputs']['filename_prefix'], 'sciepo/ep01-c01-t1')
        self.assertNotIn('{{', json.dumps(comfy.graphs))
        self.assertEqual({k: r['status'] for k, r in fake.results.items()}, {('job-0001-aaaa', 1): 'rendered', ('job-0002-bbbb', 1): 'rendered'})
        self.assertEqual(len(fake.uploaded('video')), 2)
        self.assertEqual(fake.ends[0]['reason'], 'queue_empty')
        self.assertGreaterEqual(len(fake.heartbeats), 0)
        if HAS_FFMPEG:
            checks = {c['id']: c['status'] for c in fake.results[('job-0001-aaaa', 1)]['qa']['checks']}
            # This machine has no speech recognition, so the take with lines says they were not checked.
            self.assertEqual(checks, {'duration': 'pass', 'size': 'pass', 'frame_rate': 'pass', 'audio': 'pass', 'loudness': 'pass', 'silence': 'pass', 'speech': 'warning'})
            message = next(c['message'] for c in fake.results[('job-0001-aaaa', 1)]['qa']['checks'] if c['id'] == 'speech')
            self.assertIn('not checked', message)

    def test_a_reference_with_the_wrong_hash_ends_the_session_with_an_error(self):
        comfy = self.serve(SessionComfy())
        fake = self.serve(FakeSession([{'take': make_take()}], blobs={PNG_SHA: PNG[:-1] + b'!'}))
        code, _ = self.run_session(fake, comfy)
        self.assertEqual(code, 3)
        error = next(e for e in fake.events if e['stage'] == 'error')
        self.assertIn(REF_NAME, error['message'])
        self.assertIn('SHA-256', error['message'])
        self.assertEqual(fake.ends[0]['reason'], 'error')
        self.assertEqual(fake.claims, 0)
        self.assertFalse((self.dir / 'work' / 'refs' / REF_NAME).exists())

    def test_an_untested_gpu_is_refused_unless_the_session_allows_it(self):
        self.query_gpu.return_value = ('Tesla T4', 15.0)
        fake = self.serve(FakeSession([{'take': make_take()}]))
        code, _ = self.run_session(fake)
        self.assertEqual(code, 3)
        self.assertEqual(fake.stages(), ['connected', 'gpu', 'error', 'finishing'])
        self.assertEqual(fake.events[1]['data'], {'gpu': 'Tesla T4', 'vramGb': 15.0})
        self.assertIn('Tesla T4', fake.events[2]['message'])
        self.assertEqual(fake.ends[0]['reason'], 'error')
        self.assertEqual(fake.claims, 0)
        comfy = self.serve(SessionComfy())
        allowed = self.serve(FakeSession([{'take': make_take()}], allow_untested=True))
        code, printed = self.run_session(allowed, comfy)
        self.assertEqual(code, 0, printed)
        self.assertIn('allowed for this session', next(e for e in allowed.events if e['stage'] == 'gpu')['message'])
        self.assertEqual(allowed.ends[0]['reason'], 'queue_empty')

    def test_a_mode_without_a_workflow_ends_the_session_before_any_setup(self):
        fake = self.serve(FakeSession([{'take': make_take()}], modes=['r2v', 't2va'], allow_untested=True))
        code, _ = self.run_session(fake)
        self.assertEqual(code, 3)
        self.assertEqual(fake.stages(), ['connected', 'gpu', 'error', 'finishing'])
        self.assertIn('no t2va workflow', fake.events[2]['message'])
        self.assertEqual(fake.events[2]['data'], {'stage': 'gpu'})
        self.assertEqual((fake.ends[0]['reason'], fake.claims), ('error', 0))

    def test_missing_node_classes_end_the_session_with_an_error(self):
        comfy = self.serve(SessionComfy(nodes=[n for n in REQUIRED if n not in ('MiniMaxH3ReferenceToVideo', 'VAEDecodeAudio')]))
        fake = self.serve(FakeSession([{'take': make_take()}]))
        code, _ = self.run_session(fake, comfy)
        self.assertEqual(code, 3)
        error = next(e for e in fake.events if e['stage'] == 'error')
        self.assertIn('MiniMaxH3ReferenceToVideo', error['message'])
        self.assertIn('VAEDecodeAudio', error['message'])
        self.assertEqual(fake.ends[0]['reason'], 'error')
        self.assertEqual(fake.claims, 0)

    def test_stop_after_the_take_ends_the_session_as_stopped(self):
        comfy = self.serve(SessionComfy(video=self.real_video))

        def stop(session):
            session.stop = 'after_take'
        fake = self.serve(FakeSession([{'take': make_take()}, {'take': make_take(1, 'job-0002-bbbb')}], on_claim=stop))
        code, printed = self.run_session(fake, comfy)
        self.assertEqual(code, 0, printed)
        self.assertEqual(fake.claims, 1)
        self.assertEqual(fake.results[('job-0001-aaaa', 1)]['status'], 'rendered')
        self.assertEqual(fake.ends[0]['reason'], 'stopped')
        self.assertEqual(fake.ends[0]['undelivered'], [])

    def test_stop_now_interrupts_comfyui_and_hands_the_take_back(self):
        fake = None

        def stop_now(comfy):
            fake.stop = 'now'
        comfy = self.serve(SessionComfy(hang=True, on_prompt=stop_now))
        fake = self.serve(FakeSession([{'take': make_take()}, {'take': make_take(1, 'job-0002-bbbb')}]))
        code, printed = self.run_session(fake, comfy)
        self.assertEqual(code, 0, printed)
        self.assertGreaterEqual(comfy.interrupts, 1)
        self.assertGreaterEqual(len(fake.heartbeats), 1)
        self.assertEqual(fake.results, {})
        self.assertEqual(fake.claims, 1)
        self.assertEqual(fake.ends[0]['reason'], 'stopped')
        self.assertEqual(fake.ends[0]['undelivered'], [{'jobId': 'job-0001-aaaa', 'n': 1}])

    def test_a_take_still_rendering_5_minutes_after_the_budget_is_interrupted(self):
        comfy = self.serve(SessionComfy(hang=True))
        past = (datetime.now(timezone.utc) - timedelta(minutes=6)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        fake = self.serve(FakeSession([{'take': make_take()}], budget_ends=past))
        code, printed = self.run_session(fake, comfy)
        self.assertEqual(code, 0, printed)
        self.assertGreaterEqual(comfy.interrupts, 1)
        self.assertEqual(fake.results, {})
        self.assertEqual(fake.ends[0]['reason'], 'budget')
        self.assertEqual(fake.ends[0]['undelivered'], [{'jobId': 'job-0001-aaaa', 'n': 1}])

    def test_two_failed_takes_in_a_row_end_the_session(self):
        comfy = self.serve(SessionComfy(fail=True))
        fake = self.serve(FakeSession([{'take': make_take(1, f'job-000{i}-cccc')} for i in range(1, 4)]))
        code, _ = self.run_session(fake, comfy)
        self.assertEqual(code, 3)
        self.assertEqual(fake.claims, 2)
        self.assertEqual([r['status'] for r in fake.results.values()], ['failed', 'failed'])
        self.assertTrue(all('CUDA out of memory' in r['error'] for r in fake.results.values()))
        self.assertEqual(fake.ends[0]['reason'], 'failures')
        self.assertEqual(fake.ends[0]['undelivered'], [])

    def test_an_upload_that_fails_twice_with_503_is_retried(self):
        comfy = self.serve(SessionComfy(video=self.real_video))
        fake = self.serve(FakeSession([{'take': make_take()}], upload_failures={'video': [503, 503]}))
        code, printed = self.run_session(fake, comfy)
        self.assertEqual(code, 0, printed)
        self.assertEqual([u['status'] for u in fake.uploads if u['kind'] == 'video'], [503, 503, 200])
        result = fake.results[('job-0001-aaaa', 1)]
        self.assertEqual(result['status'], 'rendered')
        self.assertEqual(result['files']['video'], fake.uploaded('video')[0]['assetId'])
        self.assertEqual(fake.ends[0]['undelivered'], [])

    def test_takes_that_cannot_be_uploaded_in_the_window_are_reported_undelivered(self):
        comfy = self.serve(SessionComfy(video=self.real_video))
        fake = self.serve(FakeSession([{'take': make_take()}], always_fail={'video'}))
        with mock.patch.object(w, 'UPLOAD_WINDOW_S', 0.3), mock.patch.object(w, 'UPLOAD_BACKOFF_S', 0.05):
            code, printed = self.run_session(fake, comfy)
        self.assertEqual(code, 0, printed)
        self.assertGreaterEqual(len(fake.uploaded('video', ok=False)), 2)
        self.assertEqual(fake.uploaded('video'), [])
        self.assertEqual(fake.results, {})
        self.assertEqual(fake.ends[0]['reason'], 'queue_empty')
        self.assertEqual(fake.ends[0]['undelivered'], [{'jobId': 'job-0001-aaaa', 'n': 1}])
        self.assertTrue(any(e['stage'] == 'error' and 'not delivered' in e['message'] for e in fake.events))

    def test_tokens_never_reach_the_log_the_events_or_the_results(self):
        comfy = self.serve(SessionComfy(fail=True, message=f'cannot load {OTHER_TOKEN} or {TOKEN}'))
        fake = self.serve(FakeSession([{'take': make_take()}, {'take': make_take(1, 'job-0002-bbbb')}]))
        code, printed = self.run_session(fake, comfy)
        self.assertEqual(code, 3)
        sent = json.dumps([fake.events, list(fake.results.values()), fake.ends])
        for text in (printed, sent):
            self.assertNotIn(TOKEN, text)
            self.assertNotIn(OTHER_TOKEN, text)
        self.assertIn('cannot load [token] or [token]', fake.results[('job-0001-aaaa', 1)]['error'])
        self.assertEqual(fake.unauthorized, 0)

    def test_an_unexpected_error_is_reported_and_ends_the_session(self):
        comfy = self.serve(SessionComfy())
        fake = self.serve(FakeSession([{'take': make_take()}]))
        with mock.patch.object(w.SessionWorker, 'fetch_references', side_effect=RuntimeError(f'boom {TOKEN}')):
            code, _ = self.run_session(fake, comfy)
        self.assertEqual(code, 3)
        error = next(e for e in fake.events if e['stage'] == 'error')
        self.assertEqual(error['message'], 'unexpected RuntimeError: boom [token]')
        self.assertEqual(error['data'], {'stage': 'ready'})
        self.assertEqual(fake.ends[0]['reason'], 'error')

    def test_an_interrupt_on_the_runtime_ends_the_session_as_stopped(self):
        comfy = self.serve(SessionComfy(video=self.real_video))
        fake = self.serve(FakeSession([{'take': make_take()}]))
        with mock.patch.object(w, 'qa_take', side_effect=KeyboardInterrupt):
            code, _ = self.run_session(fake, comfy)
        self.assertEqual(code, 0)
        self.assertEqual(fake.results, {})
        self.assertEqual(fake.ends[0]['reason'], 'stopped')
        self.assertEqual(fake.ends[0]['undelivered'], [{'jobId': 'job-0001-aaaa', 'n': 1}])

    def test_a_batch_that_is_no_longer_current_ends_after_the_take(self):
        comfy = self.serve(SessionComfy(video=self.real_video, hang=True))

        def finish_later(session):
            session.current = False
        fake = self.serve(FakeSession([{'take': make_take()}, {'take': make_take(1, 'job-0002-bbbb')}], on_claim=finish_later))
        comfy.on_prompt = lambda c: threading.Timer(0.3, lambda: setattr(c, 'hang', False)).start()
        code, printed = self.run_session(fake, comfy)
        self.assertEqual(code, 0, printed)
        self.assertEqual(fake.claims, 1)
        self.assertEqual(fake.results[('job-0001-aaaa', 1)]['status'], 'rendered')
        self.assertEqual(fake.ends[0]['reason'], 'not_current')


class FakeHub:
    """The two huggingface_hub functions the setup uses, writing files slowly so progress can be seen."""

    def __init__(self, chunks=4, delay=0.03):
        self.calls, self.chunks, self.delay = [], chunks, delay

        class HfApi:
            def get_paths_info(self, repo, paths):
                return [type('Info', (), {'size': 4000})() for _ in paths]
        self.HfApi = HfApi

    def write(self, target: Path, size: int) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, 'wb') as out:
            for _ in range(self.chunks):
                out.write(b'x' * (size // self.chunks))
                out.flush()
                time.sleep(self.delay)

    def snapshot_download(self, repo_id, allow_patterns, local_dir, max_workers):
        self.calls.append(('snapshot', repo_id, list(allow_patterns), max_workers, os.environ.get('HF_XET_HIGH_PERFORMANCE')))
        for path in allow_patterns:
            if not (Path(local_dir) / path).is_file():
                self.write(Path(local_dir) / path, 4000)
        return local_dir

    def hf_hub_download(self, repo_id, filename, local_dir):
        self.calls.append(('file', repo_id, filename))
        self.write(Path(local_dir) / filename, 400)
        return str(Path(local_dir) / filename)


class SetupTests(SessionTestCase):
    def worker(self, fake: FakeSession) -> w.SessionWorker:
        return w.SessionWorker(w.SessionClient(fake.url, TOKEN), comfy_dir=self.dir / 'comfy', work_dir=self.dir / 'work', comfy_url='http://127.0.0.1:9')

    def test_model_files_download_into_comfyui_with_progress_events(self):
        fake, hub = self.serve(FakeSession([])), FakeHub()
        files = w.model_files([stack_document()], ['r2v', 't2va'])
        self.assertEqual(len(files), 7)
        with mock.patch.dict(sys.modules, {'huggingface_hub': hub}), mock.patch.dict(os.environ), mock.patch.object(w, 'DOWNLOAD_EVENT_S', 0.05):
            self.worker(fake).download_models(files)
        models = self.dir / 'comfy' / 'models'
        snapshot = next(c for c in hub.calls if c[0] == 'snapshot')
        self.assertEqual((snapshot[1], snapshot[3], snapshot[4]), ('Comfy-Org/MiniMax-H3', 4, '1'))
        self.assertEqual(len(snapshot[2]), 6)
        self.assertIn(('file', 'lightx2v/Minimax-h3-Turbo', 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'), hub.calls)
        self.assertEqual((models / 'loras' / 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors').stat().st_size, 400)
        self.assertTrue((models / 'diffusion_models' / 'minimax_h3_ref2va_pruned_int8_convrot.safetensors').is_file())
        progress = [e['data'] for e in fake.events if e['stage'] == 'downloading']
        self.assertGreaterEqual(len(progress), 3)
        self.assertEqual(progress[0]['bytesTotal'], int(15.69 * 1e9) + int(20.97 * 1e9) + 5 * 4000)  # `gb` where given, else Hugging Face's size
        self.assertEqual(progress[-1], {'bytesDone': 6 * 4000 + 400, 'bytesTotal': 6 * 4000 + 400})
        done = [p['bytesDone'] for p in progress]
        self.assertEqual(done, sorted(done))

    def test_a_stop_during_the_download_ends_the_setup(self):
        fake, hub = self.serve(FakeSession([])), FakeHub(chunks=20, delay=0.05)
        fake.stop = 'after_take'
        with mock.patch.dict(sys.modules, {'huggingface_hub': hub}), mock.patch.dict(os.environ), mock.patch.object(w, 'DOWNLOAD_EVENT_S', 0.05):
            with self.assertRaises(w.SessionEnded) as ended:
                self.worker(fake).download_models(w.model_files([stack_document()], ['r2v']))
        self.assertEqual(ended.exception.reason, 'stopped')
        for thread in threading.enumerate():  # let the abandoned download finish before the folder is removed
            if thread.name == 'model download':
                thread.join(30)

    def test_the_setup_installs_the_pinned_comfyui_and_starts_it(self):
        fake = self.serve(FakeSession([]))
        worker = self.worker(fake)
        commands = []
        with mock.patch.object(w, 'run_command', side_effect=lambda command, cwd=None, timeout=0: commands.append([str(c) for c in command]) or ''), \
                mock.patch.object(w.SessionWorker, 'comfy_commit', side_effect=[None, stack_document()['comfyui']['commit']]), \
                mock.patch.object(w.SessionWorker, 'download_models') as download, mock.patch.object(w.SessionWorker, 'start_comfyui') as start, \
                mock.patch.object(w.shutil, 'which', return_value='git'):
            worker.setup([stack_document()], ['r2v'])
        commit = stack_document()['comfyui']['commit']
        self.assertEqual(commands[0][:4], ['git', 'clone', '--depth', '1'])
        self.assertIn(['git', '-C', str(self.dir / 'comfy'), 'fetch', '--depth', '1', 'origin', commit], commands)
        self.assertIn(['git', '-C', str(self.dir / 'comfy'), 'checkout', '--quiet', commit], commands)
        self.assertIn([sys.executable, '-m', 'pip', 'install', '-q', '-r', 'requirements.txt'], commands)
        self.assertIn([sys.executable, '-m', 'pip', 'install', '-q', 'huggingface_hub[hf_transfer]'], commands)
        self.assertEqual([f['dest'] for f in download.call_args.args[0]][:3], [f['path'] for f in stack_document()['files']['common']])
        start.assert_called_once()
        self.assertEqual(fake.stages(), ['installing', 'starting_comfyui'])


@unittest.skipUnless(HAS_FFMPEG, 'ffmpeg and ffprobe are needed to make and measure clips')
class QaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_short_silent_take_fails_its_duration_and_warns_about_silence(self):
        video = self.dir / 'silent.mp4'
        done = w.subprocess.run([w.find_tool('ffmpeg'), '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=480x864:rate=24', '-f', 'lavfi',
                                 '-i', 'anullsrc=r=48000:cl=stereo', '-t', '3', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
                                 '-c:a', 'aac', str(video)], capture_output=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        take = make_take(frames=120, shots=[{'shotId': 's1', 'start': 0, 'end': 2.5}, {'shotId': 's2', 'start': 2.5, 'end': 5.0}])
        heard = {'language': 'en', 'segments': [{'start': 0.2, 'end': 1.0, 'text': 'last order'}]}
        with mock.patch.object(w, 'transcribe', return_value=heard) as transcribe:
            summary, files = w.qa_take(video, take)
        transcribe.assert_called_once_with(video, 'en')
        checks = {c['id']: c for c in summary['checks']}
        self.assertEqual(checks['duration']['status'], 'failure')
        self.assertAlmostEqual(checks['duration']['value'], 3.0, places=1)
        self.assertEqual((checks['size']['status'], checks['frame_rate']['status'], checks['audio']['status']), ('pass', 'pass', 'pass'))
        self.assertEqual(checks['silence']['status'], 'warning')
        self.assertIn('0.0–3.0 s', checks['silence']['message'])
        self.assertEqual(checks['loudness']['status'], 'pass')
        self.assertNotIn('loudness', summary)  # digital silence has no true peak to report
        self.assertEqual((checks['line']['status'], checks['line']['value']), ('pass', 1.0))
        self.assertEqual(summary['speech'], {'language': 'en', 'lines': [{'sceneId': 'sc1', 'position': 2, 'language': 'en', 'expected': 'Last order.',
                                                                          'heard': 'last order', 'score': 1.0}]})
        self.assertEqual([k['shotId'] for k in files['keyframes']], ['s1', 's2'])
        self.assertTrue(files['contactSheet'].read_bytes().startswith(b'\xff\xd8\xff'))
        data = json.loads(files['qa'].read_text(encoding='utf-8'))
        self.assertEqual(data['silences'][0]['start'], 0.0)
        self.assertEqual(data['speech']['segments'], heard['segments'])

    def test_marked_files_stay_valid_and_differ(self):
        clip = w.render_rehearsal(make_take(), self.dir / 'a' / 'clip.mp4', note='one')
        again = w.render_rehearsal(make_take(), self.dir / 'b' / 'clip.mp4', note='two')
        self.assertNotEqual(clip.read_bytes(), again.read_bytes())
        sheet = w.make_contact_sheet(clip, make_take(), 2.0)
        before = sheet.read_bytes()
        w.mark_jpeg(sheet, 'sciepo session s job j take 1')
        after = sheet.read_bytes()
        self.assertNotEqual(before, after)
        self.assertTrue(after.startswith(b'\xff\xd8\xff'))
        self.assertIn(b'sciepo session s job j take 1', after)
        probe = w.subprocess.run([w.find_tool('ffprobe'), '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', str(sheet)],
                                 capture_output=True, text=True)
        self.assertEqual(probe.stdout.strip(), '1454,324')  # eight 180 px tiles with 2 px between them, one row
        tagged = w.tag_video(clip, 'sciepo session s job j take 1')
        self.assertIn(b'sciepo session s job j take 1', tagged.read_bytes())
        self.assertEqual(w.probe_seconds(tagged), 2.0)


# --------------------------------------------------------------------------- Google Drive storage and cuts

ACCOUNT = 'writer@example.com'
DRIVE_FOLDER = ['Sci-epo', "Maya's \\ project", 'takes']
CUT_FOLDER = ['Sci-epo', "Maya's \\ project", 'cuts']


class FakeResponse:
    def __init__(self, status, payload=None, headers=None, raw=b''):
        self.status_code, self.headers, self.payload, self.raw = status, dict(headers or {}), payload, raw

    def json(self):
        if self.payload is None:
            raise ValueError('no JSON body')
        return self.payload

    @property
    def text(self):
        return json.dumps(self.payload) if self.payload is not None else self.raw.decode('utf-8', 'replace')

    def iter_content(self, chunk_size=1):
        for at in range(0, len(self.raw), chunk_size):
            yield self.raw[at:at + chunk_size]

    def close(self):
        pass


class FakeDrive:
    """Google Drive REST v3 as DriveClient calls it through a requests-style session: about, folder search and creation,
    resumable uploads (308 with Range), link permissions and alt=media downloads. Failures can be injected."""

    API = 'https://www.googleapis.com/drive/v3'
    UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'

    def __init__(self, account=ACCOUNT, chunk_failures=0, upload_status=None):
        self.account, self.chunk_failures, self.upload_status = account, chunk_failures, upload_status
        self.folders, self.files, self.sessions = {}, {}, {}
        self.permissions, self.downloads, self.queries, self.created, self.chunks, self.calls = [], [], [], [], 0, []
        self.lock = threading.Lock()

    def new_id(self, prefix):
        return f'{prefix}{len(self.folders) + len(self.files) + len(self.sessions) + 1:04d}_fakeid'

    def add_folder(self, name, parent='root'):
        folder_id = self.new_id('fold')
        self.folders[folder_id] = {'name': name, 'parent': parent}
        return folder_id

    def add_file(self, data, name='clip.mp4', parent='root'):
        file_id = self.new_id('file')
        self.files[file_id] = {'name': name, 'parent': parent, 'data': bytes(data), 'mimeType': 'video/mp4'}
        return file_id

    def path_of(self, folder_id):
        path = []
        while folder_id != 'root':
            path.insert(0, self.folders[folder_id]['name'])
            folder_id = self.folders[folder_id]['parent']
        return path

    def request(self, method, url, params=None, json=None, data=None, headers=None, stream=False, timeout=None):  # noqa: A002, PLR0911
        with self.lock:
            split = urllib.parse.urlsplit(url)
            params = {**dict(urllib.parse.parse_qsl(split.query)), **(params or {})}
            base = f'{split.scheme}://{split.netloc}{split.path}'
            headers = headers or {}
            self.calls.append((method, base))
            if method == 'GET' and base == f'{self.API}/about':
                assert params['fields'] == 'user(emailAddress)'
                return FakeResponse(200, {'user': {'emailAddress': self.account}})
            if method == 'GET' and base == f'{self.API}/files':
                self.queries.append(params['q'])
                found = re.fullmatch(r"name = '((?:[^'\\]|\\.)*)' and '((?:[^'\\]|\\.)*)' in parents and "
                                     r"mimeType = 'application/vnd\.google-apps\.folder' and trashed = false", params['q'])
                assert found, params['q']
                name, parent = (re.sub(r'\\(.)', r'\1', group) for group in found.groups())
                return FakeResponse(200, {'files': [{'id': i, 'name': f['name']} for i, f in self.folders.items()
                                                    if f['name'] == name and f['parent'] == parent]})
            if method == 'POST' and base == f'{self.API}/files':
                assert json['mimeType'] == 'application/vnd.google-apps.folder'
                folder_id = self.add_folder(json['name'], json['parents'][0])
                self.created.append(json['name'])
                return FakeResponse(200, {'id': folder_id})
            if method == 'POST' and base == self.UPLOAD:
                assert params == {'uploadType': 'resumable', 'fields': 'id,name'}, params
                if self.upload_status:
                    return FakeResponse(self.upload_status, {'error': {'message': 'Backend Error'}})
                uri = f'{self.UPLOAD}?uploadType=resumable&upload_id=u{len(self.sessions) + 1}'
                self.sessions[uri] = {'meta': json, 'size': int(headers['X-Upload-Content-Length']), 'data': bytearray(),
                                      'type': headers['X-Upload-Content-Type']}
                return FakeResponse(200, None, {'Location': uri})
            if method == 'PUT' and url in self.sessions:
                upload = self.sessions[url]
                held = len(upload['data'])
                if headers['Content-Range'] == f"bytes */{upload['size']}":
                    return FakeResponse(308, None, {'Range': f'bytes=0-{held - 1}'} if held else {})
                self.chunks += 1
                if self.chunk_failures:
                    self.chunk_failures -= 1
                    upload['data'].extend(data[:len(data) // 2])  # half the chunk arrived before the connection broke
                    raise ConnectionError('connection reset by peer')
                start, end, total = map(int, re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', headers['Content-Range']).groups())
                assert (start, end - start + 1, total, int(headers['Content-Length'])) == (held, len(data), upload['size'], len(data))
                upload['data'].extend(data)
                if len(upload['data']) < upload['size']:
                    return FakeResponse(308, None, {'Range': f"bytes=0-{len(upload['data']) - 1}"})
                meta = upload['meta']
                file_id = self.add_file(upload['data'], meta['name'], meta['parents'][0])
                self.files[file_id]['mimeType'] = meta['mimeType']
                return FakeResponse(200, {'id': file_id, 'name': meta['name']})
            found = re.fullmatch(re.escape(self.API) + r'/files/([A-Za-z0-9_-]+)(/permissions)?', base)
            if found and method == 'POST' and found.group(2):
                self.permissions.append((found.group(1), json))
                return FakeResponse(200, {'id': 'anyoneWithLink'})
            if found and method == 'GET' and params.get('alt') == 'media':
                self.downloads.append(found.group(1))
                item = self.files.get(found.group(1))
                return FakeResponse(200, raw=item['data']) if item else FakeResponse(404, {'error': {'message': 'File not found'}})
            return FakeResponse(400, {'error': {'message': f'unexpected {method} {base}'}})


REAL_OPEN_DRIVE = w.open_drive_session


def drive_take(n=1, job='job-0001-aaaa', **overrides):
    return make_take(n, job, drive={'folder': DRIVE_FOLDER, 'share': 'link'}, **overrides)


def sent_to_sciepo(fake: FakeSession) -> str:
    """Everything the worker sent to the fake Sci-epo, as one text."""
    return json.dumps([fake.events, list(fake.results.values()), fake.cut_results, fake.ends, fake.args_calls], ensure_ascii=False)


class DriveClientTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        patcher = mock.patch.object(w, 'UPLOAD_BACKOFF_S', 0.01)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def test_folders_are_found_or_created_once_with_quoted_names(self):
        drive = FakeDrive()
        top = drive.add_folder('Sci-epo')
        client = w.DriveClient(session=drive)
        leaf = client.folder(DRIVE_FOLDER)
        self.assertEqual(client.folder(DRIVE_FOLDER), leaf)
        self.assertEqual(drive.path_of(leaf), DRIVE_FOLDER)
        self.assertEqual(drive.created, DRIVE_FOLDER[1:])  # Sci-epo was there already
        self.assertEqual(len(drive.queries), 3)
        self.assertIn("name = 'Maya\\'s \\\\ project'", drive.queries[1])
        self.assertIn(f"'{top}' in parents", drive.queries[1])
        self.assertEqual(w.DriveClient(session=drive).folder(DRIVE_FOLDER), leaf)  # a new client finds them all
        self.assertEqual(len(drive.created), 2)

    def test_a_resumable_upload_continues_where_drive_stopped(self):
        drive = FakeDrive(chunk_failures=2)
        data = os.urandom(300_000)
        path = self.dir / 'take.mp4'
        path.write_bytes(data)
        with mock.patch.object(w, 'DRIVE_CHUNK', 64 * 1024), contextlib.redirect_stdout(io.StringIO()):
            found = w.DriveClient(session=drive).upload(path, 'ep01-c01-t1.mp4', 'root')
        self.assertEqual(drive.files[found['id']]['data'], data)
        self.assertEqual((found['name'], drive.files[found['id']]['mimeType']), ('ep01-c01-t1.mp4', 'video/mp4'))
        # Two broken PUTs that each left half a chunk with Drive, then four chunks from the offsets Drive reported.
        self.assertEqual(drive.chunks, 2 + 4)

    def test_downloads_are_checked_against_size_and_sha256(self):
        drive = FakeDrive()
        data = b'clip bytes' * 1000
        file_id = drive.add_file(data)
        client = w.DriveClient(session=drive)
        client.download(file_id, self.dir / 'clip-01.mp4', hashlib.sha256(data).hexdigest(), len(data))
        self.assertEqual((self.dir / 'clip-01.mp4').read_bytes(), data)
        with self.assertRaisesRegex(w.WorkerError, 'SHA-256'):
            client.download(file_id, self.dir / 'clip-02.mp4', '0' * 64, len(data))
        with self.assertRaisesRegex(w.WorkerError, 'larger'):
            client.download(file_id, self.dir / 'clip-03.mp4', hashlib.sha256(data).hexdigest(), 10)
        with self.assertRaisesRegex(w.WorkerError, 'HTTP 404.*File not found'):
            client.download('nosuchfile', self.dir / 'clip-04.mp4', '0' * 64, 10)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ['clip-01.mp4'])

    def test_server_errors_are_retried_and_then_reported(self):
        drive = FakeDrive(upload_status=503)
        path = self.dir / 'take.mp4'
        path.write_bytes(b'x' * 10)
        with contextlib.redirect_stdout(io.StringIO()) as out, self.assertRaisesRegex(w.WorkerError, r'HTTP 503: Backend Error.*6 times'):
            w.DriveClient(session=drive).upload(path, 'take.mp4', 'root')
        self.assertEqual(out.getvalue().count('trying again'), 5)


class DriveSessionTests(SessionTestCase):
    def setUp(self):
        super().setUp()
        self.drive = FakeDrive()
        patcher = mock.patch.object(w, 'open_drive_session', return_value=self.drive)
        patcher.start()
        self.addCleanup(patcher.stop)

    @unittest.skipUnless(HAS_FFMPEG, 'ffmpeg and ffprobe are needed for rehearsal renders')
    def test_rehearsal_takes_go_to_google_drive_shared_by_link(self):
        self.drive.add_folder('Sci-epo')
        takes = [drive_take(rehearsal=True), drive_take(1, 'job-0002-bbbb', output='ep01-c02.mp4', rehearsal=True)]
        fake = self.serve(FakeSession([{'take': t} for t in takes], mode='rehearsal', storage={'video': 'drive'}, work={'takes': 2, 'cuts': 0}))
        with mock.patch.object(w, 'DRIVE_CHUNK', 64 * 1024):
            code, printed = self.run_session(fake)
        self.assertEqual(code, 0, printed)
        self.query_gpu.assert_not_called()
        self.assertFalse({'gpu', 'installing', 'error'} & set(fake.stages()))
        self.assertIn('Google Drive', next(e for e in fake.events if e['stage'] == 'ready')['message'])
        self.assertIn('to Google Drive', next(e for e in fake.events if e['stage'] == 'uploading')['message'])
        self.assertEqual([u for u in fake.uploads if u['kind'] == 'video'], [])  # never offered to Sci-epo
        self.assertEqual(len(fake.uploaded('contact-sheet')), 2)
        self.assertEqual(len(fake.uploaded('keyframe')), 4)
        self.assertEqual(len(fake.uploaded('qa')), 2)
        for (job, n), take in zip(sorted(fake.results), takes):
            result = fake.results[(job, n)]
            self.assertEqual(result['status'], 'rendered')
            self.assertNotIn('video', result['files'])
            self.assertEqual(set(result['files']), {'contactSheet', 'keyframes', 'qa'})
            video = result['video']
            stored = self.drive.files[video['drive']['id']]
            self.assertEqual(video['drive'], {'id': video['drive']['id'], 'name': f"{Path(take['output']).stem}-t1.mp4"})
            self.assertEqual((video['sha256'], video['bytes']), (hashlib.sha256(stored['data']).hexdigest(), len(stored['data'])))
            self.assertEqual(stored['data'][4:8], b'ftyp')
            self.assertEqual(self.drive.path_of(stored['parent']), DRIVE_FOLDER)
            self.assertIn((video['drive']['id'], {'type': 'anyone', 'role': 'reader'}), self.drive.permissions)
        self.assertEqual(self.drive.created, DRIVE_FOLDER[1:])
        self.assertEqual(len(self.drive.permissions), 2)
        self.assertEqual(fake.ends[0]['reason'], 'queue_empty')
        self.assertIn(ACCOUNT, printed)  # shown on the runtime only
        self.assertNotIn(ACCOUNT, sent_to_sciepo(fake))

    def test_a_drive_upload_that_keeps_failing_leaves_the_take_undelivered(self):
        self.drive.upload_status = 503
        comfy = self.serve(SessionComfy(video=self.real_video))
        fake = self.serve(FakeSession([{'take': drive_take()}], storage={'video': 'drive'}))
        with mock.patch.object(w, 'UPLOAD_WINDOW_S', 0.3), mock.patch.object(w, 'UPLOAD_BACKOFF_S', 0.05):
            code, printed = self.run_session(fake, comfy)
        self.assertEqual(code, 0, printed)
        self.assertEqual(fake.results, {})
        self.assertEqual([u for u in fake.uploads if u['kind'] == 'video'], [])
        self.assertEqual(self.drive.files, {})
        self.assertEqual(fake.ends[0]['undelivered'], [{'jobId': 'job-0001-aaaa', 'n': 1}])
        error = next(e for e in fake.events if e['stage'] == 'error' and 'not delivered' in e['message'])
        self.assertIn('did not reach Google Drive', error['message'])
        self.assertIn('HTTP 503', error['message'])

    def test_a_take_without_a_drive_folder_fails_before_it_renders(self):
        comfy = self.serve(SessionComfy(video=self.real_video))
        fake = self.serve(FakeSession([{'take': make_take()}], storage={'video': 'drive'}))
        code, printed = self.run_session(fake, comfy)
        self.assertEqual(code, 0, printed)
        self.assertEqual(comfy.graphs, [])
        self.assertEqual(fake.results[('job-0001-aaaa', 1)]['status'], 'failed')
        self.assertIn('Google Drive folder', fake.results[('job-0001-aaaa', 1)]['error'])

    def test_missing_google_authorization_ends_the_session_before_any_work(self):
        class DefaultCredentialsError(Exception):
            pass
        auth = mock.Mock(default=mock.Mock(side_effect=DefaultCredentialsError('Your default credentials were not found.')))
        google = mock.Mock(auth=auth)
        modules = {'google': google, 'google.auth': auth, 'google.auth.transport': auth.transport,
                   'google.auth.transport.requests': mock.Mock(AuthorizedSession=mock.Mock())}
        fake = self.serve(FakeSession([{'take': drive_take()}], mode='rehearsal', storage={'video': 'drive'}))
        with mock.patch.object(w, 'open_drive_session', REAL_OPEN_DRIVE), mock.patch.dict(sys.modules, modules):
            code, printed = self.run_session(fake)
        self.assertEqual(code, 3, printed)
        self.assertEqual(fake.stages(), ['connected', 'error', 'finishing'])
        self.assertIn('Google Drive is not authorized', fake.events[1]['message'])
        self.assertIn('notebook cell', fake.events[1]['message'])
        auth.default.assert_called_once_with(scopes=['https://www.googleapis.com/auth/drive'])
        self.assertEqual((fake.claims, fake.ends[0]['reason']), (0, 'error'))

    def test_media_storage_never_touches_google_drive(self):
        comfy = self.serve(SessionComfy(video=self.real_video))
        fake = self.serve(FakeSession([{'take': make_take()}], storage={'video': 'media'}, work={'takes': 1, 'cuts': 0}))
        code, printed = self.run_session(fake, comfy)
        self.assertEqual(code, 0, printed)
        self.assertEqual(self.drive.calls, [])
        self.assertEqual(len(fake.uploaded('video')), 1)
        result = fake.results[('job-0001-aaaa', 1)]
        self.assertNotIn('video', result)
        self.assertEqual(result['files']['video'], fake.uploaded('video')[0]['assetId'])

    def test_a_pull_session_without_takes_or_cuts_still_ends_at_once(self):
        fake = self.serve(FakeSession([], modes=[], storage={'video': 'drive'}, work={'takes': 0, 'cuts': 0}))
        code, printed = self.run_session(fake)
        self.assertEqual(code, 0, printed)
        self.assertEqual((fake.claims, fake.ends[0]['reason']), (0, 'queue_empty'))


@unittest.skipUnless(HAS_FFMPEG, 'ffmpeg and ffprobe are needed to make cuts')
class CutTests(SessionTestCase):
    """Cuts-only sessions: no GPU, inputs from Google Drive, Sci-epo's ffmpeg arguments, the cut back to Drive."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        folder = Path(tempfile.mkdtemp(prefix='sciepo-cut-'))
        cls.other_video = w.render_rehearsal(make_take(output='ep01-c02.mp4'), folder / 'clip2.mp4', note='second').read_bytes()
        music = folder / 'music.wav'
        done = w.subprocess.run([w.find_tool('ffmpeg'), '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=4',
                                 '-ac', '2', str(music)], capture_output=True)
        assert done.returncode == 0, done.stderr
        cls.music = music.read_bytes()

    def setUp(self):
        super().setUp()
        self.drive = FakeDrive()
        for name, value in (('open_drive_session', mock.Mock(return_value=self.drive)), ('caption_font', mock.Mock(side_effect=w.font_file))):
            patcher = mock.patch.object(w, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def make_cut(self, cut_id='cut-0001-aaaaaaaa', inputs=None, captions=True, music=True):
        inputs = inputs or [self.real_video, self.other_video]
        entries = []
        for index, data in enumerate(inputs, start=1):
            file_id = self.drive.add_file(data, f'ep01-c0{index}-t1.mp4')
            entries.append({'name': f'clip-0{index}.mp4', 'clipId': f'c0{index}', 'drive': {'id': file_id, 'name': f'ep01-c0{index}-t1.mp4'},
                            'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
        return {'id': cut_id, 'batchId': 'batch-1', 'language': 'en', 'kind': 'episode', 'inputs': entries,
                'music': {'name': 'music.wav', 'sha256': hashlib.sha256(self.music).hexdigest(), 'bytes': len(self.music)} if music else None,
                'captions': [{'name': 'caption-001.txt', 'text': 'Last order.\n最后一单'}] if captions else [],
                'output': {'name': f'ep01-en-{cut_id[-4:]}.mp4', 'drive': {'folder': CUT_FOLDER, 'share': 'link'}}, 'timeoutSeconds': 300}

    @staticmethod
    def concat(font, music=True, captions=True):
        """Real ffmpeg arguments, as Sci-epo's planner would build them: two clips joined, music mixed under, a caption drawn."""
        graph = '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]'
        graph += ';[a][2:a]amix=inputs=2:duration=first[am]' if music else ''
        if captions:
            font_option = 'fontfile=caption-font.ttc:' if font else ''
            graph += f';[v]drawtext={font_option}textfile=caption-001.txt:fontsize=32:fontcolor=white:x=20:y=20[vt]'
        return ['-y', '-hide_banner', '-nostdin', '-i', 'clip-01.mp4', '-i', 'clip-02.mp4', *(['-i', 'music.wav'] if music else []),
                '-filter_complex', graph, '-map', '[vt]' if captions else '[v]', '-map', '[am]' if music else '[a]',
                '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', 'cut.mp4']

    def args(self, plan=None):
        """Sci-epo's args endpoint: pass 1 measures the music, the render pass joins the clips; `plan` overrides per cut."""
        plan = plan or {}

        def answer(cut_id, body):
            custom = plan.get(cut_id, {})
            if 'measured' not in body:
                return {'args': custom.get('pass1', ['-hide_banner', '-nostdin', '-i', 'music.wav', '-af', 'volumedetect', '-f', 'null', '-'])}
            return {'args': custom.get('render', self.concat(body['font'])), 'fallback': custom.get('fallback', self.concat(False, captions=False)),
                    'warnings': ['the music is 2 s shorter than the cut']}
        return answer

    def cuts_session(self, cuts, plan=None, **options):
        return self.serve(FakeSession([{'cut': c} for c in cuts], modes=[], stacks=[], references=[], storage={'video': 'drive'},
                                      work={'takes': 0, 'cuts': len(cuts)}, music=self.music, cut_args=self.args(plan), **options))

    def test_a_cuts_only_session_skips_the_gpu_and_makes_the_cut_in_drive(self):
        cut = self.make_cut()
        fake = self.cuts_session([cut])
        code, printed = self.run_session(fake)
        self.assertEqual(code, 0, printed)
        self.query_gpu.assert_not_called()
        stages = fake.stages()
        self.assertFalse({'gpu', 'installing', 'downloading', 'starting_comfyui', 'error'} & set(stages))
        self.assertEqual([s for s in stages if s in ('connected', 'ready', 'cutting', 'uploading', 'finishing')],
                         ['connected', 'ready', 'cutting', 'uploading', 'finishing'])
        self.assertIn('no GPU', next(e for e in fake.events if e['stage'] == 'ready')['message'])
        self.assertEqual(sorted(self.drive.downloads), sorted(i['drive']['id'] for i in cut['inputs']))
        self.assertEqual(fake.music_gets, 1)
        font = w.font_file() is not None
        self.assertEqual([body for _, body in fake.args_calls][0], {'audio': {'clip-01.mp4': True, 'clip-02.mp4': True}, 'font': font})
        second = fake.args_calls[1][1]
        self.assertEqual((second['audio'], second['font']), (fake.args_calls[0][1]['audio'], font))
        self.assertIn('mean_volume', second['measured'])
        result = fake.cut_results[cut['id']]
        self.assertEqual(result['status'], 'done', result)
        stored = self.drive.files[result['drive']['id']]
        self.assertEqual(result['drive'], {'id': result['drive']['id'], 'name': cut['output']['name']})
        self.assertEqual((result['sha256'], result['bytes']), (hashlib.sha256(stored['data']).hexdigest(), len(stored['data'])))
        self.assertEqual(self.drive.path_of(stored['parent']), CUT_FOLDER)
        self.assertEqual(self.drive.permissions, [(result['drive']['id'], {'type': 'anyone', 'role': 'reader'})])
        self.assertAlmostEqual(result['seconds'], 4.0, delta=0.1)
        self.assertIn('Integrated loudness', result['loudness'])
        self.assertIn('True peak', result['loudness'])
        self.assertEqual(result['warnings'], ['the music is 2 s shorter than the cut'])  # the captions were drawn
        probe = self.dir / 'probe.mp4'
        probe.write_bytes(stored['data'])
        info = w.ffprobe_info(probe)
        self.assertEqual({s['codec_type'] for s in info['streams']}, {'video', 'audio'})
        self.assertGreaterEqual(len(fake.cut_heartbeats), 1)
        self.assertEqual(fake.uploads, [])
        self.assertFalse((self.dir / 'work' / 'cuts' / cut['id'][:8]).exists())
        self.assertEqual(fake.ends[0]['reason'], 'queue_empty')
        self.assertIn('cuts: 1 done, 0 failed', fake.ends[0]['summary']['message'])
        self.assertNotIn(ACCOUNT, sent_to_sciepo(fake))

    def test_without_a_caption_font_the_worker_says_so(self):
        cut = self.make_cut()
        fake = self.cuts_session([cut])
        with mock.patch.object(w, 'caption_font', return_value=None):
            code, printed = self.run_session(fake)
        self.assertEqual(code, 0, printed)
        self.assertEqual([body['font'] for _, body in fake.args_calls], [False, False])
        self.assertEqual(fake.cut_results[cut['id']]['status'], 'done')

    def test_failed_cuts_post_failed_and_the_fallback_saves_a_render(self):
        bad_hash = self.make_cut('cut-0001-aaaaaaaa')
        bad_hash['inputs'][1]['sha256'] = '0' * 64
        fallback = self.make_cut('cut-0002-bbbbbbbb')
        broken = self.make_cut('cut-0003-cccccccc')
        not_a_list = self.make_cut('cut-0004-dddddddd')
        plan = {fallback['id']: {'render': ['-y', '-i', 'clip-01.mp4', '-vf', 'nosuchfilter', 'cut.mp4']},
                broken['id']: {'render': ['-y', '-i', 'missing.mp4', 'cut.mp4'], 'fallback': None},
                not_a_list['id']: {'pass1': '-i music.wav -f null -'}}
        fake = self.cuts_session([bad_hash, fallback, broken, not_a_list], plan)
        code, printed = self.run_session(fake)
        self.assertEqual(code, 3, printed)
        results = fake.cut_results
        self.assertEqual({k: r['status'] for k, r in results.items()},
                         {bad_hash['id']: 'failed', fallback['id']: 'done', broken['id']: 'failed', not_a_list['id']: 'failed'})
        self.assertIn('SHA-256', results[bad_hash['id']]['error'])
        self.assertIn('could not render the cut', results[broken['id']]['error'])
        self.assertIn('not a list of ffmpeg arguments', results[not_a_list['id']]['error'])
        self.assertTrue(all(len(r.get('error', '')) <= 500 for r in results.values()))
        self.assertEqual(results[fallback['id']]['warnings'][0], 'the music is 2 s shorter than the cut')
        self.assertIn('fallback pass without captions', results[fallback['id']]['warnings'][1])
        self.assertEqual(len(self.drive.permissions), 1)
        self.assertEqual((fake.claims, fake.ends[0]['reason']), (4, 'failures'))
        self.assertIn('cuts: 1 done, 3 failed', fake.ends[0]['summary']['message'])
        self.assertEqual(list((self.dir / 'work' / 'cuts').iterdir()), [])

    def test_stop_now_kills_ffmpeg_and_leaves_the_cut_to_sci_epo(self):
        cut = self.make_cut()
        fake = None
        endless = ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '3600', '-c:v', 'libx264', '-f', 'null', '-']
        base = self.args({cut['id']: {'render': endless}})

        def answer(cut_id, body):
            if 'measured' in body:
                fake.stop = 'now'
            return base(cut_id, body)
        fake = self.cuts_session([cut, self.make_cut('cut-0002-bbbbbbbb')])
        fake.cut_args = answer
        started = time.monotonic()
        code, printed = self.run_session(fake)
        self.assertEqual(code, 0, printed)
        self.assertLess(time.monotonic() - started, 60)
        self.assertEqual(fake.cut_results, {})
        self.assertEqual(self.drive.permissions, [])
        self.assertEqual((fake.claims, fake.ends[0]['reason']), (1, 'stopped'))
        self.assertFalse((self.dir / 'work' / 'cuts' / cut['id'][:8]).exists())


if __name__ == '__main__':
    unittest.main()
