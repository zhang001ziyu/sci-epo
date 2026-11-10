"""Offline tests for sciepo_worker.py: fake ComfyUI and Sci-epo servers on localhost, no GPU.

Run from the repository root:  python -m unittest discover -s worker/tests -v
"""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sciepo_worker as w  # noqa: E402

VIDEO = b'\x00\x00\x00\x18ftypmp42fake-h3-video'


def job(**overrides):
    base = {'id': 'j1', 'clipId': 'c01', 'language': 'en', 'mode': 't2va', 'prompt': 'integrated_multimodal_description: [Shot 1] ...',
            'frames': 124, 'seconds': 5.17, 'width': 768, 'height': 1344, 'seed': 42, 'images': [], 'audio': [], 'output': 'ep01-c01-en.mp4'}
    base.update(overrides)
    return base


def package(jobs):
    return {'format': w.PACKAGE_FORMAT, 'version': 1, 'batch': {'id': 'b1'}, 'model': {'name': 'MiniMax H3'}, 'references': {'images': [], 'audio': []}, 'jobs': jobs}


T2V = {
    '3': {'class_type': 'KSampler', 'inputs': {'seed': 7, 'model': ['4', 0], 'positive': ['6', 0], 'latent_image': ['5', 0]}},
    '4': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'minimax_h3.safetensors'}},
    '5': {'class_type': 'MiniMaxH3Latent', 'inputs': {'width': 1344, 'height': 768, 'length': 124}},
    '6': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'a long default prompt about a bakery at sunrise', 'clip': ['7', 0]}},
    '7': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'qwen3vl.safetensors'}},
    '8': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'short', 'clip': ['7', 0]}},
    '9': {'class_type': 'SaveVideo', 'inputs': {'filename_prefix': 'video/h3', 'video': ['3', 0]}},
}
R2V = {
    '1': {'class_type': 'LoadImage', 'inputs': {'image': 'hero.png'}},
    '2': {'class_type': 'LoadImage', 'inputs': {'image': 'friend.png'}},
    '10': {'class_type': 'ImageScale', 'inputs': {'image': ['2', 0], 'width': 512, 'height': 512}},
    '11': {'class_type': 'MiniMaxH3ReferenceToVideo', 'inputs': {'positive': ['6', 0], 'ref_image_0': ['1', 0], 'ref_image_1': ['10', 0], 'width': 768, 'height': 1344, 'length': 124}},
    '6': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'reference prompt that is the longest text here', 'clip': ['7', 0]}},
    '7': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'qwen3vl.safetensors'}},
    '9': {'class_type': 'SaveVideo', 'inputs': {'filename_prefix': 'video/h3', 'video': ['11', 0]}},
}


class FakeComfy:
    """Implements /upload/image, /prompt, /history/<id> and /view like ComfyUI."""

    def __init__(self, fail=False):
        self.graphs, self.uploads, self.polls, self.fail = [], [], 0, fail
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def reply(self, status, payload, raw=None):
                body = raw if raw is not None else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):  # noqa: N802
                body = self.rfile.read(int(self.headers['content-length']))
                if self.path == '/upload/image':
                    name = body.split(b'filename="')[1].split(b'"')[0].decode()
                    outer.uploads.append(name)
                    return self.reply(200, {'name': name, 'subfolder': '', 'type': 'input'})
                if self.path == '/prompt':
                    outer.graphs.append(json.loads(body)['prompt'])
                    return self.reply(200, {'prompt_id': f'p{len(outer.graphs)}', 'number': 1})
                return self.reply(404, {})

            def do_GET(self):  # noqa: N802
                if self.path.startswith('/history/'):
                    outer.polls += 1
                    pid = self.path.rsplit('/', 1)[1]
                    if outer.polls % 2:
                        return self.reply(200, {})
                    if outer.fail:
                        return self.reply(200, {pid: {'status': {'status_str': 'error', 'completed': False, 'messages': [['execution_error', {'exception_message': 'CUDA out of memory'}]]}, 'outputs': {}}})
                    return self.reply(200, {pid: {'status': {'status_str': 'success', 'completed': True}, 'outputs': {'9': {'images': [{'filename': f'h3_{pid}.mp4', 'subfolder': 'video', 'type': 'output'}], 'animated': [True]}}}})
                if self.path.startswith('/view?'):
                    return self.reply(200, None, VIDEO)
                return self.reply(404, {})

            def log_message(self, *args):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class FakeSciEpo:
    """Implements the worker API: hello, claim, heartbeat and result."""

    def __init__(self, jobs, token='sciepo_wk_test'):
        self.jobs, self.results, self.heartbeats, self.token = list(jobs), {}, 0, token
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def reply(self, status, payload=None):
                body = b'' if payload is None else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def ok(self):
                if self.headers.get('authorization') != f'Bearer {outer.token}':
                    self.reply(401, {'error': 'bad token'})
                    return False
                return True

            def do_GET(self):  # noqa: N802
                if self.ok():
                    self.reply(200, {'service': 'sci-epo', 'worker': 'test box'}) if self.path == '/api/worker/v1/hello' else self.reply(404, {})

            def do_POST(self):  # noqa: N802
                if not self.ok():
                    return
                length = int(self.headers.get('content-length') or 0)
                body = json.loads(self.rfile.read(length) or b'{}')
                if self.path == '/api/worker/v1/claim':
                    if not outer.jobs:
                        return self.reply(204)
                    return self.reply(200, {'batch': {'id': 'b1'}, 'model': {}, 'job': outer.jobs.pop(0)})
                parts = self.path.split('/')
                if parts[-1] == 'heartbeat':
                    outer.heartbeats += 1
                    return self.reply(200, {'leaseExpiresAt': 'later'})
                if parts[-1] == 'result':
                    outer.results[parts[-2]] = body
                    return self.reply(200, {'ok': True})
                return self.reply(404, {})

            def log_message(self, *args):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class WorkflowTests(unittest.TestCase):
    def test_placeholders_keep_numbers_as_numbers(self):
        used = set()
        graph = w.substitute({'a': '{{WIDTH}}', 'b': 'prefix {{SEED}}', 'c': ['{{PROMPT}}', 3]}, {'WIDTH': 768, 'SEED': 9, 'PROMPT': 'p'}, used)
        self.assertEqual(graph, {'a': 768, 'b': 'prefix 9', 'c': ['p', 3]})
        self.assertEqual(used, {'WIDTH', 'SEED', 'PROMPT'})
        with self.assertRaises(w.WorkerError):
            w.substitute({'a': '{{IMAGE_2}}'}, {}, set())

    def test_prepare_workflow_marks_prompt_size_frames_seed_output_and_references(self):
        graph, changes = w.prepare_workflow(T2V)
        self.assertEqual(graph['6']['inputs']['text'], '{{PROMPT}}')
        self.assertEqual(graph['8']['inputs']['text'], 'short')
        self.assertEqual(graph['5']['inputs'], {'width': '{{WIDTH}}', 'height': '{{HEIGHT}}', 'length': '{{FRAMES}}'})
        self.assertEqual(graph['3']['inputs']['seed'], '{{SEED}}')
        self.assertEqual(graph['9']['inputs']['filename_prefix'], '{{OUTPUT_PREFIX}}')
        self.assertTrue(any('{{PROMPT}}' in line for line in changes))
        r2v, _ = w.prepare_workflow(R2V)
        self.assertEqual((r2v['1']['inputs']['image'], r2v['2']['inputs']['image']), ('{{IMAGE_1}}', '{{IMAGE_2}}'))
        with self.assertRaises(w.WorkerError):
            w.prepare_workflow({'nodes': [], 'links': []})

    def test_unused_reference_slots_are_pruned_with_their_links(self):
        r2v, _ = w.prepare_workflow(R2V)
        pruned = w.prune_missing_references(r2v, {'PROMPT', 'IMAGE_1'})
        self.assertNotIn('2', pruned)
        self.assertNotIn('10', pruned)
        self.assertNotIn('ref_image_1', pruned['11']['inputs'])
        self.assertEqual(pruned['11']['inputs']['ref_image_0'], ['1', 0])
        self.assertIn('9', pruned)


class ComfyUITests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        (self.dir / 'refs').mkdir()
        (self.dir / 'refs' / 'maya.png').write_bytes(b'png')

    def tearDown(self):
        self.tmp.cleanup()

    def backend(self, comfy):
        t2v, _ = w.prepare_workflow(T2V)
        r2v, _ = w.prepare_workflow(R2V)
        return w.ComfyUIBackend(comfy.url, {'t2va': t2v, 'r2v': r2v}, self.dir / 'refs', timeout_s=30, poll_s=0.01)

    def test_renders_t2va_and_r2v_jobs_and_downloads_the_video(self):
        comfy = FakeComfy()
        try:
            backend = self.backend(comfy)
            entry = backend.render(job(), self.dir / 'out')
            graph = comfy.graphs[0]
            self.assertEqual(graph['6']['inputs']['text'], job()['prompt'])
            self.assertEqual(graph['5']['inputs'], {'width': 768, 'height': 1344, 'length': 124})
            self.assertEqual(graph['3']['inputs']['seed'], 42)
            self.assertEqual(graph['9']['inputs']['filename_prefix'], 'sciepo/ep01-c01-en')
            self.assertEqual(entry['status'], 'succeeded')
            self.assertEqual(entry['file'], 'ep01-c01-en.mp4')
            self.assertEqual(entry['sha256'], hashlib.sha256(VIDEO).hexdigest())
            self.assertEqual((self.dir / 'out' / 'ep01-c01-en.mp4').read_bytes(), VIDEO)
            r2v = backend.render(job(id='j2', mode='r2v', images=['maya.png'], output='ep01-c01-zh-CN.mp4'), self.dir / 'out')
            self.assertEqual(r2v['status'], 'succeeded')
            self.assertEqual(comfy.uploads, ['maya.png'])
            self.assertEqual(comfy.graphs[1]['1']['inputs']['image'], 'maya.png')
            self.assertNotIn('2', comfy.graphs[1])
        finally:
            comfy.close()

    def test_errors_are_reported_not_raised_past_the_job(self):
        comfy = FakeComfy(fail=True)
        try:
            entry = w.render_one(self.backend(comfy), job(), self.dir / 'out')
            self.assertEqual(entry['status'], 'failed')
            self.assertIn('CUDA out of memory', entry['error'])
            missing = w.render_one(self.backend(comfy), job(mode='r2v', images=['nobody.png']), self.dir / 'out')
            self.assertIn('nobody.png', missing['error'])
        finally:
            comfy.close()

    def test_package_mode_resumes_from_results_json(self):
        comfy = FakeComfy()
        try:
            pkg = package([job(), job(id='j2', language='zh-CN', output='ep01-c01-zh-CN.mp4'), job(id='j3', output='ep01-c02-en.mp4', status='succeeded')])
            results = w.run_package(w.check_package(pkg), self.backend(comfy), self.dir / 'out')
            self.assertEqual(sorted(results.entries), ['j1', 'j2'])
            self.assertEqual(len(comfy.graphs), 2)
            saved = json.loads((self.dir / 'out' / 'results.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['format'], 'sciepo-render-results')
            self.assertEqual({r['status'] for r in saved['results']}, {'succeeded'})
            w.run_package(w.check_package(pkg), self.backend(comfy), self.dir / 'out')
            self.assertEqual(len(comfy.graphs), 2)
        finally:
            comfy.close()


class ModeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_dry_run_writes_prompts_and_never_succeeds(self):
        results = w.run_package(w.check_package(package([job()])), w.DryRunBackend(), self.dir)
        self.assertEqual(results.entries['j1']['status'], 'dry_run')
        self.assertIn('[Shot 1]', (self.dir / 'ep01-c01-en.mp4.prompt.txt').read_text(encoding='utf-8'))
        with self.assertRaises(w.WorkerError):
            w.run_pull(w.SciEpo('http://127.0.0.1:9', 't'), w.DryRunBackend(), self.dir, wait=False, poll_s=0)

    def test_invalid_jobs_and_packages_are_refused(self):
        with self.assertRaises(w.WorkerError):
            w.check_package({'format': 'other'})
        with self.assertRaises(w.WorkerError):
            w.validate_job(job(output='../escape.mp4'))
        with self.assertRaises(w.WorkerError):
            w.validate_job(job(images=['../../etc/passwd']))
        with self.assertRaises(w.WorkerError):
            w.SciEpo('http://studio.example.com', 't')

    def test_pull_mode_claims_renders_and_reports(self):
        comfy, sciepo = FakeComfy(), FakeSciEpo([job(), job(id='j2', language='zh-CN', output='ep01-c01-zh-CN.mp4')])
        try:
            t2v, _ = w.prepare_workflow(T2V)
            backend = w.ComfyUIBackend(comfy.url, {'t2va': t2v}, None, timeout_s=30, poll_s=0.01)
            done = w.run_pull(w.SciEpo(sciepo.url, 'sciepo_wk_test'), backend, self.dir, wait=False, poll_s=0)
            self.assertEqual(done, 2)
            self.assertEqual(set(sciepo.results), {'j1', 'j2'})
            self.assertEqual(sciepo.results['j1']['status'], 'succeeded')
            self.assertEqual(sciepo.results['j1']['file'], 'ep01-c01-en.mp4')
            self.assertNotIn('finishedAt', sciepo.results['j1'])
            self.assertTrue((self.dir / 'b1' / 'ep01-c01-zh-CN.mp4').is_file())
            with self.assertRaises(w.WorkerError):
                w.run_pull(w.SciEpo(sciepo.url, 'wrong'), backend, self.dir, wait=False, poll_s=0)
        finally:
            comfy.close()
            sciepo.close()

    def test_serve_mode_accepts_a_package_with_the_key_and_returns_results(self):
        state = w.ServeState(w.DryRunBackend(), self.dir)
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), w.make_handler(state, 'secret-key-1'))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{httpd.server_port}'
        try:
            def call(method, path, payload=None, key='secret-key-1'):
                return w.http_json(method, base + path, payload, {'authorization': f'Bearer {key}'})
            self.assertEqual(call('POST', '/v1/batches', package([job()]), key='wrong')[0], 401)
            self.assertEqual(call('POST', '/v1/batches', {'format': 'x'})[0], 400)
            status, answer = call('POST', '/v1/batches', package([job()]))
            self.assertEqual((status, answer), (200, {'batchId': 'b1', 'jobs': 1}))
            for _ in range(100):
                status, results = call('GET', '/v1/batches/b1/results')
                if results['results']:
                    break
                time.sleep(0.02)
            self.assertEqual(results['format'], 'sciepo-render-results')
            self.assertEqual(results['results'][0]['status'], 'dry_run')
            self.assertEqual(urllib.request.urlopen(base + '/v1/health').status, 200)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_command_backend_quotes_values_and_requires_the_output(self):
        script = self.dir / 'fake_h3.py'
        script.write_text('import sys, pathlib\nargs = dict(zip(sys.argv[1::2], sys.argv[2::2]))\n'
                          'assert pathlib.Path(args["--prompt"]).read_text().startswith("integrated")\n'
                          'pathlib.Path(args["--out"]).write_bytes(b"video")\n', encoding='utf-8')
        backend = w.CommandBackend(f'"{sys.executable}" "{script}" --prompt {{prompt_file}} --out {{output}}', None, 60)
        if sys.platform.startswith('win'):
            self.skipTest('the command backend quotes for POSIX shells, as in Colab')
        entry = backend.render(job(), self.dir / 'out dir')
        self.assertEqual(entry['status'], 'succeeded')
        broken = w.CommandBackend('true', None, 60)
        self.assertEqual(w.render_one(broken, job(id='j9', output='never.mp4'), self.dir)['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
