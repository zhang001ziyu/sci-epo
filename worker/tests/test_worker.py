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


LIGHTNING = {'title': 'Boolean (Enable Lightning LoRA)'}
# The wiring of ComfyUI's official H3 templates as Export (API) writes them, with neutral values.
# T2V wraps the H3 node in a subgraph, so its inner nodes have ids like '140:131'.
T2V = {
    '92': {'class_type': 'SaveVideo', 'inputs': {'filename_prefix': 'video/MiniMax_H3', 'format': 'auto', 'codec': 'auto', 'video': ['140:130', 0]}},
    '115': {'class_type': 'ResolutionSelector', 'inputs': {'aspect_ratio': '16:9 (Widescreen)', 'megapixels': 0.4, 'multiple': 32}},
    '140:119': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'video_vae.safetensors'}},
    '140:120': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'audio_vae.safetensors'}},
    '140:121': {'class_type': 'VAEDecodeAudio', 'inputs': {'samples': ['140:125', 0], 'vae': ['140:120', 0]}},
    '140:122': {'class_type': 'VAEDecode', 'inputs': {'samples': ['140:125', 0], 'vae': ['140:119', 0]}},
    '140:125': {'class_type': 'SamplerCustomAdvanced', 'inputs': {'noise': ['140:129', 0], 'latent_image': ['140:131', 1]}},
    '140:128': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'text_encoder.safetensors', 'type': 'minimax', 'device': 'default'}},
    '140:129': {'class_type': 'RandomNoise', 'inputs': {'noise_seed': 757358688076805}},
    '140:130': {'class_type': 'CreateVideo', 'inputs': {'fps': 24, 'images': ['140:122', 0], 'audio': ['140:121', 0]}},
    '140:131': {'class_type': 'MiniMaxH3ImageToVideo', 'inputs': {'prompt': 'a template prompt about a title sequence', 'width': ['115', 0], 'height': ['115', 1], 'length': ['140:132', 1], 'clip': ['140:128', 0], 'vae': ['140:119', 0]}},
    '140:132': {'class_type': 'ComfyMathExpression', 'inputs': {'expression': 'max(5, round(a * 24))', 'values.a': ['140:133', 0]}},
    '140:133': {'class_type': 'PrimitiveFloat', 'inputs': {'value': 2}, '_meta': {'title': 'Float (duration)'}},
    '140:139': {'class_type': 'PrimitiveBoolean', 'inputs': {'value': False}, '_meta': LIGHTNING},
}
# R2V keeps the H3 node in the main graph: the prompt comes from a text box, the size from a resolution
# selector and the frame count from a duration formula. An ImageScale sits in front of the second slot.
R2V = {
    '10': {'class_type': 'ImageScale', 'inputs': {'image': ['139', 0], 'upscale_method': 'lanczos', 'width': 512, 'height': 512, 'crop': 'disabled'}},
    '92': {'class_type': 'SaveVideo', 'inputs': {'filename_prefix': 'video/MiniMax_H3', 'format': 'auto', 'codec': 'auto', 'video': ['130', 0]}},
    '115': {'class_type': 'ResolutionSelector', 'inputs': {'aspect_ratio': '16:9 (Widescreen)', 'megapixels': 0.4, 'multiple': 32}},
    '119': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'video_vae.safetensors'}},
    '120': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'audio_vae.safetensors'}},
    '121': {'class_type': 'VAEDecodeAudio', 'inputs': {'samples': ['125', 0], 'vae': ['120', 0]}},
    '122': {'class_type': 'VAEDecode', 'inputs': {'samples': ['125', 0], 'vae': ['119', 0]}},
    '125': {'class_type': 'SamplerCustomAdvanced', 'inputs': {'noise': ['129', 0], 'latent_image': ['136', 1]}},
    '128': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'text_encoder.safetensors', 'type': 'minimax', 'device': 'default'}},
    '129': {'class_type': 'RandomNoise', 'inputs': {'noise_seed': 261662374822964}},
    '130': {'class_type': 'CreateVideo', 'inputs': {'fps': 24, 'images': ['122', 0], 'audio': ['121', 0]}},
    '131': {'class_type': 'ComfyMathExpression', 'inputs': {'expression': 'max(5, round(a * 24))', 'values.a': ['132', 0]}},
    '132': {'class_type': 'PrimitiveFloat', 'inputs': {'value': 5}, '_meta': {'title': 'Float (Duration)'}},
    '136': {'class_type': 'MiniMaxH3ReferenceToVideo', 'inputs': {'prompt': ['138', 0], 'width': ['115', 0], 'height': ['115', 1], 'length': ['131', 1], 'ref_image_size': 'match',
            'clip': ['128', 0], 'vae': ['119', 0], 'audio_vae': ['120', 0], 'ref_images.ref_image_0': ['137', 0], 'ref_images.ref_image_1': ['10', 0]}},
    '137': {'class_type': 'LoadImage', 'inputs': {'image': 'hero.png'}},
    '138': {'class_type': 'PrimitiveStringMultiline', 'inputs': {'value': 'a template prompt with two reference pictures'}, '_meta': {'title': 'Input Text (Prompt)'}},
    '139': {'class_type': 'LoadImage', 'inputs': {'image': 'friend.png'}},
    '146': {'class_type': 'PrimitiveBoolean', 'inputs': {'value': False}, '_meta': LIGHTNING},
}
# A workflow without the native H3 nodes, where placeholders are guessed from input names.
GENERIC = {
    '3': {'class_type': 'KSampler', 'inputs': {'seed': 7, 'model': ['4', 0], 'positive': ['6', 0], 'latent_image': ['5', 0]}},
    '4': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'video.safetensors'}},
    '5': {'class_type': 'EmptyVideoLatent', 'inputs': {'width': 1344, 'height': 768, 'length': 124}},
    '6': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'a long default prompt about a bakery at sunrise', 'clip': ['7', 0]}},
    '7': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'text_encoder.safetensors'}},
    '8': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'short', 'clip': ['7', 0]}},
    '9': {'class_type': 'SaveVideo', 'inputs': {'filename_prefix': 'video/h3', 'video': ['3', 0]}},
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

    def test_official_t2v_template_gets_its_values_on_the_h3_node_inside_the_subgraph(self):
        graph, changes = w.prepare_workflow(T2V)
        h3 = graph['140:131']['inputs']
        self.assertEqual((h3['prompt'], h3['width'], h3['height'], h3['length']), ('{{PROMPT}}', '{{WIDTH}}', '{{HEIGHT}}', '{{FRAMES}}'))
        self.assertEqual(graph['140:129']['inputs']['noise_seed'], '{{SEED}}')
        self.assertEqual(graph['92']['inputs']['filename_prefix'], '{{OUTPUT_PREFIX}}')
        self.assertEqual(graph['140:133']['inputs']['value'], 2)
        self.assertEqual(graph['140:139']['inputs']['value'], False)
        self.assertFalse([line for line in changes if 'WARNING' in line], changes)
        self.assertTrue(any("width: 'link from node 115' -> {{WIDTH}}" in line for line in changes), changes)
        turbo, changes = w.prepare_workflow(T2V, turbo=True)
        self.assertIs(turbo['140:139']['inputs']['value'], True)
        self.assertTrue(any('Lightning LoRA turned on' in line for line in changes))

    def test_official_r2v_template_maps_reference_slots_and_adds_the_missing_ones(self):
        graph, changes = w.prepare_workflow(R2V)
        h3 = graph['136']['inputs']
        self.assertEqual((h3['prompt'], h3['width'], h3['height'], h3['length']), ('{{PROMPT}}', '{{WIDTH}}', '{{HEIGHT}}', '{{FRAMES}}'))
        self.assertEqual(graph['137']['inputs']['image'], '{{IMAGE_1}}')
        self.assertEqual(graph['139']['inputs']['image'], '{{IMAGE_2}}')
        self.assertEqual(graph['10']['inputs']['width'], 512)
        self.assertEqual(graph['138']['inputs']['value'], 'a template prompt with two reference pictures')
        for index in range(2, 9):
            loader = graph[str(h3[f'ref_images.ref_image_{index}'][0])]
            self.assertEqual(loader, {'class_type': 'LoadImage', 'inputs': {'image': f'{{{{IMAGE_{index + 1}}}}}'}, '_meta': {'title': f'Sci-epo ref image {index + 1}'}})
        for index in range(3):
            loader = graph[str(h3[f'ref_audios.ref_audio_{index}'][0])]
            self.assertEqual(loader['class_type'], 'LoadAudio')
            self.assertEqual(loader['inputs'], {'audio': f'{{{{AUDIO_{index + 1}}}}}'})
        self.assertEqual(graph['129']['inputs']['noise_seed'], '{{SEED}}')
        self.assertFalse([line for line in changes if 'WARNING' in line], changes)
        again, changes = w.prepare_workflow(graph)
        self.assertEqual(again, graph)
        self.assertEqual(changes, [])
        self.assertIs(w.prepare_workflow(R2V, turbo=True)[0]['146']['inputs']['value'], True)

    def test_other_workflows_fall_back_to_input_names(self):
        graph, changes = w.prepare_workflow(GENERIC)
        self.assertEqual(graph['6']['inputs']['text'], '{{PROMPT}}')
        self.assertEqual(graph['8']['inputs']['text'], 'short')
        self.assertEqual(graph['5']['inputs'], {'width': '{{WIDTH}}', 'height': '{{HEIGHT}}', 'length': '{{FRAMES}}'})
        self.assertEqual(graph['3']['inputs']['seed'], '{{SEED}}')
        self.assertEqual(graph['9']['inputs']['filename_prefix'], '{{OUTPUT_PREFIX}}')
        self.assertTrue(any('no MiniMax H3 node found' in line for line in changes))
        _, changes = w.prepare_workflow(GENERIC, turbo=True)
        self.assertTrue(any('--turbo found no' in line for line in changes))
        with self.assertRaises(w.WorkerError):
            w.prepare_workflow({'nodes': [], 'links': []})

    def test_unused_reference_slots_are_pruned_with_their_links(self):
        r2v, _ = w.prepare_workflow(R2V)
        pruned = w.prune_missing_references(r2v, {'PROMPT', 'WIDTH', 'HEIGHT', 'FRAMES', 'SEED', 'OUTPUT_PREFIX', 'IMAGE_1'})
        self.assertNotIn('139', pruned)
        self.assertNotIn('10', pruned)
        self.assertEqual([k for k in pruned['136']['inputs'] if k.startswith('ref_')], ['ref_image_size', 'ref_images.ref_image_0'])
        self.assertEqual(pruned['136']['inputs']['ref_images.ref_image_0'], ['137', 0])
        self.assertFalse([n for n in pruned.values() if n['class_type'] in ('LoadImage', 'LoadAudio') and n is not pruned['137']])
        self.assertIn('92', pruned)
        self.assertEqual(w.placeholders_in(pruned) - {'PROMPT', 'WIDTH', 'HEIGHT', 'FRAMES', 'SEED', 'OUTPUT_PREFIX', 'IMAGE_1'}, set())


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
            h3 = graph['140:131']['inputs']
            self.assertEqual((h3['prompt'], h3['width'], h3['height'], h3['length']), (job()['prompt'], 768, 1344, 124))
            self.assertEqual(graph['140:129']['inputs']['noise_seed'], 42)
            self.assertEqual(graph['92']['inputs']['filename_prefix'], 'sciepo/ep01-c01-en')
            self.assertEqual(entry['status'], 'succeeded')
            self.assertEqual(entry['file'], 'ep01-c01-en.mp4')
            self.assertEqual(entry['sha256'], hashlib.sha256(VIDEO).hexdigest())
            self.assertEqual((self.dir / 'out' / 'ep01-c01-en.mp4').read_bytes(), VIDEO)
            r2v = backend.render(job(id='j2', mode='r2v', images=['maya.png'], output='ep01-c01-zh-CN.mp4'), self.dir / 'out')
            self.assertEqual(r2v['status'], 'succeeded')
            self.assertEqual(comfy.uploads, ['maya.png'])
            sent = comfy.graphs[1]
            self.assertEqual(sent['137']['inputs']['image'], 'maya.png')
            self.assertNotIn('139', sent)
            self.assertEqual([k for k in sent['136']['inputs'] if k.startswith('ref_images.')], ['ref_images.ref_image_0'])
            self.assertEqual((sent['136']['inputs']['width'], sent['136']['inputs']['height'], sent['136']['inputs']['length']), (768, 1344, 124))
            self.assertNotIn('{{', json.dumps(sent))
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
