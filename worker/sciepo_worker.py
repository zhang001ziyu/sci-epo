#!/usr/bin/env python3
"""Sci-epo render worker for MiniMax H3.

Sci-epo plans render jobs from an adopted shot list: one job is one clip in one voice language,
with its H3 prompt, frame count, size, seed and reference files. This worker renders them.

Modes
  package           render a job package file downloaded from Sci-epo
  pull              claim jobs from a Sci-epo server with a worker token
  serve             accept job packages over HTTP, for a tunnel from Colab to Sci-epo
  prepare-workflow  add placeholders to a ComfyUI workflow exported in API format

Backends
  comfyui   queue an API-format workflow on a ComfyUI server
  command   run your own command for each job
  dry-run   write the prompts only; never reports success

Videos and results.json are written to the output folder. Nothing is uploaded except job status.
Standard library only; Python 3.10 or later.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

PACKAGE_FORMAT = 'sciepo-render-package'
RESULTS_FORMAT = 'sciepo-render-results'
RESULTS_FILE = 'results.json'
SAFE_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$')
TOKEN = re.compile(r'\{\{([A-Z][A-Z0-9_]*)\}\}')
VIDEO_EXTENSIONS = ('.mp4', '.webm', '.mov', '.mkv')
IMAGE_INPUT_NODES = ('LoadImage',)
AUDIO_INPUT_NODES = ('LoadAudio', 'VHS_LoadAudio', 'VHS_LoadAudioUpload')
# ComfyUI's native H3 nodes (comfy_extras/nodes_minimax_h3.py). Each takes prompt, width, height and length directly.
H3_GENERATORS = ('MiniMaxH3ReferenceToVideo', 'MiniMaxH3ImageToVideo', 'EmptyMiniMaxH3LatentAV')
REF_IMAGE_INPUT = re.compile(r'^(ref_images\.)?ref_image_(\d+)$')
REF_AUDIO_INPUT = re.compile(r'^(ref_audios\.)?ref_audio_(\d+)$')
MAX_REF_IMAGES = 9
MAX_REF_AUDIO = 3


class WorkerError(Exception):
    """A job could not be rendered; the message is reported to Sci-epo."""


def log(message: str) -> None:
    print(f'[sciepo-worker] {message}', flush=True)


# --------------------------------------------------------------------------- jobs and results

def validate_job(job: Any) -> dict:
    if not isinstance(job, dict):
        raise WorkerError('job is not an object')
    checks: dict[str, Callable[[Any], bool]] = {
        'id': lambda v: isinstance(v, str) and 0 < len(v) <= 100,
        'mode': lambda v: v in ('t2va', 'r2v'),
        'prompt': lambda v: isinstance(v, str) and 0 < len(v) <= 60_000,
        'frames': lambda v: isinstance(v, int) and 1 <= v <= 1000,
        'width': lambda v: isinstance(v, int) and 64 <= v <= 4096,
        'height': lambda v: isinstance(v, int) and 64 <= v <= 4096,
        'seed': lambda v: isinstance(v, int) and v >= 0,
        'images': lambda v: isinstance(v, list) and len(v) <= 9 and all(isinstance(x, str) and SAFE_NAME.match(x) for x in v),
        'audio': lambda v: isinstance(v, list) and len(v) <= 3 and all(isinstance(x, str) and SAFE_NAME.match(x) for x in v),
        'output': lambda v: isinstance(v, str) and bool(SAFE_NAME.match(v)),
    }
    for key, check in checks.items():
        if not check(job.get(key)):
            raise WorkerError(f'job field {key!r} is missing or invalid')
    return job


def load_package(path: Path) -> dict:
    try:
        package = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise WorkerError(f'cannot read job package {path}: {error}') from error
    return check_package(package)


def check_package(package: Any) -> dict:
    if not isinstance(package, dict) or package.get('format') != PACKAGE_FORMAT or package.get('version') != 1:
        raise WorkerError('not a Sci-epo job package (format sciepo-render-package, version 1)')
    batch = package.get('batch')
    if not isinstance(batch, dict) or not isinstance(batch.get('id'), str):
        raise WorkerError('job package has no batch id')
    jobs = package.get('jobs')
    if not isinstance(jobs, list) or not jobs:
        raise WorkerError('job package has no jobs')
    for job in jobs:
        validate_job(job)
    return package


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def probe_seconds(path: Path) -> float | None:
    """Duration from ffprobe when it is installed (Colab has it); otherwise None."""
    exe = shutil.which('ffprobe')
    if not exe:
        return None
    try:
        out = subprocess.run([exe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                             capture_output=True, text=True, timeout=60, check=True).stdout.strip()
        return round(float(out), 2)
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


def succeeded(job: dict, path: Path) -> dict:
    if not path.is_file() or path.stat().st_size == 0:
        raise WorkerError(f'no video was written to {path.name}')
    seconds = probe_seconds(path)
    entry = {'jobId': job['id'], 'status': 'succeeded', 'file': path.name, 'bytes': path.stat().st_size,
             'sha256': file_sha256(path), 'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    entry['seconds'] = seconds if seconds is not None else round(job['frames'] / 24, 2)
    entry['secondsSource'] = 'ffprobe' if seconds is not None else 'planned'
    return entry


def failed(job: dict, message: str) -> dict:
    return {'jobId': job['id'], 'status': 'failed', 'error': message[:500],
            'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}


class Results:
    """results.json in the output folder, rewritten after every job so a stopped run can resume."""

    def __init__(self, out_dir: Path, batch_id: str):
        self.path = Path(out_dir) / RESULTS_FILE
        self.batch_id = batch_id
        self.entries: dict[str, dict] = {}
        self.lock = threading.Lock()
        if self.path.is_file():
            try:
                data = json.loads(self.path.read_text(encoding='utf-8'))
                if data.get('format') == RESULTS_FORMAT and data.get('batchId') == batch_id:
                    self.entries = {e['jobId']: e for e in data.get('results', []) if isinstance(e, dict) and 'jobId' in e}
            except (OSError, ValueError, KeyError):
                log(f'ignoring unreadable {self.path}')

    def done(self, job_id: str) -> bool:
        return self.entries.get(job_id, {}).get('status') == 'succeeded'

    def record(self, entry: dict) -> None:
        with self.lock:
            self.entries[entry['jobId']] = entry
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix('.json.tmp')
            tmp.write_text(json.dumps(self.manifest(), ensure_ascii=False, indent=2), encoding='utf-8')
            os.replace(tmp, self.path)

    def manifest(self) -> dict:
        return {'format': RESULTS_FORMAT, 'version': 1, 'batchId': self.batch_id, 'results': list(self.entries.values())}


# --------------------------------------------------------------------------- HTTP

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - never follow redirects
        raise urllib.error.HTTPError(req.full_url, code, f'redirect to {newurl} refused', headers, fp)


_opener = urllib.request.build_opener(_NoRedirect)


def http(method: str, url: str, body: bytes | None = None, headers: dict | None = None, timeout: float = 60) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with _opener.open(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        try:
            return error.code, error.read() if error.fp else b''
        finally:
            error.close()
    except (urllib.error.URLError, OSError) as error:
        raise WorkerError(f'cannot reach {urllib.parse.urlsplit(url).netloc}: {getattr(error, "reason", error)}') from error


def http_json(method: str, url: str, payload: Any = None, headers: dict | None = None, timeout: float = 60) -> tuple[int, Any]:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode('utf-8')
    status, raw = http(method, url, body, {'accept': 'application/json', **({'content-type': 'application/json'} if body is not None else {}), **(headers or {})}, timeout)
    if not raw:
        return status, None
    try:
        return status, json.loads(raw.decode('utf-8'))
    except ValueError:
        return status, {'error': raw[:200].decode('utf-8', 'replace')}


def multipart(fields: dict[str, str], file_field: str, path: Path) -> tuple[bytes, str]:
    boundary = f'----sciepo{uuid.uuid4().hex}'
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{path.name}"\r\n'
                 f'Content-Type: application/octet-stream\r\n\r\n'.encode())
    parts.append(path.read_bytes())
    parts.append(f'\r\n--{boundary}--\r\n'.encode())
    return b''.join(parts), f'multipart/form-data; boundary={boundary}'


# --------------------------------------------------------------------------- workflows

def substitute(node: Any, values: dict[str, Any], used: set[str]) -> Any:
    """Replace {{NAME}} placeholders. A value that is exactly one placeholder takes the value's type."""
    if isinstance(node, str):
        whole = TOKEN.fullmatch(node)
        if whole:
            key = whole.group(1)
            used.add(key)
            if key not in values:
                raise WorkerError(f'the workflow needs {{{{{key}}}}}, but this job has no value for it')
            return values[key]

        def embed(match: re.Match) -> str:
            key = match.group(1)
            used.add(key)
            if key not in values:
                raise WorkerError(f'the workflow needs {{{{{key}}}}}, but this job has no value for it')
            return str(values[key])
        return TOKEN.sub(embed, node)
    if isinstance(node, list):
        return [substitute(item, values, used) for item in node]
    if isinstance(node, dict):
        return {key: substitute(value, values, used) for key, value in node.items()}
    return node


def placeholders_in(node: Any) -> set[str]:
    found: set[str] = set()
    if isinstance(node, str):
        found.update(TOKEN.findall(node))
    elif isinstance(node, list):
        for item in node:
            found |= placeholders_in(item)
    elif isinstance(node, dict):
        for value in node.values():
            found |= placeholders_in(value)
    return found


def prune_missing_references(graph: dict, available: set[str]) -> dict:
    """Remove load nodes for reference slots this job does not fill, and the links to them.
    One R2V workflow with nine image slots then serves a clip with one or two reference pictures."""
    graph = json.loads(json.dumps(graph))
    removed: set[str] = set()
    for node_id, node in graph.items():
        keys = placeholders_in(node.get('inputs', {})) if isinstance(node, dict) else set()
        slots = {k for k in keys if re.fullmatch(r'(IMAGE|AUDIO)_\d+', k)}
        if slots and not slots <= available:
            removed.add(node_id)
    # A node fed only by removed nodes (a resize in front of the H3 node, say) goes too; a node that
    # keeps other inputs, like the H3 node itself, only loses the optional reference input.
    changed = True
    while changed:
        changed = False
        for node_id, node in graph.items():
            if node_id in removed or not isinstance(node, dict):
                continue
            inputs = node.get('inputs', {})
            links = [name for name, value in inputs.items() if is_link(value)]
            dropped = [name for name in links if str(inputs[name][0]) in removed]
            if not dropped:
                continue
            if len(dropped) == len(links):
                removed.add(node_id)
            else:
                for name in dropped:
                    del inputs[name]
            changed = True
    for node_id in removed:
        graph.pop(node_id, None)
    return graph


def is_link(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 2 and isinstance(value[1], int)


def node_order(node_id: str) -> tuple:
    """Numeric order for ids such as '9', '115' and '140:131' (nodes of a flattened subgraph)."""
    return tuple((0, int(part), '') if part.isdigit() else (1, 0, part) for part in str(node_id).split(':'))


def upstream(graph: dict, node_id: str, classes: tuple[str, ...], depth: int = 4) -> str | None:
    """The nearest node of one of these classes at or above node_id, following links up to `depth` steps."""
    seen: set[str] = set()
    frontier = [str(node_id)]
    for _ in range(depth + 1):
        following: list[str] = []
        for current in frontier:
            node = graph.get(current)
            if current in seen or not isinstance(node, dict):
                continue
            seen.add(current)
            if node.get('class_type') in classes:
                return current
            following += [str(v[0]) for v in node.get('inputs', {}).values() if is_link(v)]
        frontier = following
    return None


def prepare_workflow(graph: dict, turbo: bool = False) -> tuple[dict, list[str]]:
    """Insert placeholders into an API-format workflow; return the graph and a change log.

    With ComfyUI's native H3 nodes, prompt, width, height and length are set on the H3 node itself, so the
    templates' prompt box, resolution selector and duration formula are bypassed, and every reference slot
    of an R2V node gets a load node. Other workflows fall back to guessing by input names."""
    if not isinstance(graph, dict) or not graph or not all(isinstance(n, dict) and 'class_type' in n for n in graph.values()):
        raise WorkerError('this is not a ComfyUI workflow in API format (use Workflow > Export (API) in ComfyUI)')
    graph = json.loads(json.dumps(graph))
    changes: list[str] = []
    ids = sorted(graph, key=node_order)

    def put(node_id: str, name: str, token: str) -> None:
        old = graph[node_id]['inputs'].get(name)
        new = '{{' + token + '}}'
        graph[node_id]['inputs'][name] = new
        if old == new:
            return
        shown = f'link from node {old[0]}' if is_link(old) else old if not isinstance(old, str) or len(old) < 60 else old[:57] + '...'
        changes.append(f'node {node_id} ({graph[node_id]["class_type"]}) {name}: {shown!r} -> {new}')

    generators = [i for i in ids if graph[i]['class_type'] in H3_GENERATORS]
    for node_id in generators:
        inputs = graph[node_id].setdefault('inputs', {})
        for name, token in (('prompt', 'PROMPT'), ('width', 'WIDTH'), ('height', 'HEIGHT'), ('length', 'FRAMES')):
            if name in inputs:
                put(node_id, name, token)
        if graph[node_id]['class_type'] == 'MiniMaxH3ReferenceToVideo':
            add_reference_slots(graph, node_id, put, changes)
    if not generators:
        changes.append('no MiniMax H3 node found; placeholders are guessed from input names')
        texts = [(len(v), node_id, name) for node_id in ids for name, v in graph[node_id].get('inputs', {}).items()
                 if isinstance(v, str) and name in ('text', 'prompt', 'positive', 'prompt_text', 'value')]
        if texts:
            _, node_id, name = max(texts)
            put(node_id, name, 'PROMPT')
        numeric = {'width': 'WIDTH', 'height': 'HEIGHT', 'length': 'FRAMES', 'frames': 'FRAMES', 'num_frames': 'FRAMES', 'video_length': 'FRAMES'}
        images = audio = 0
        for node_id in ids:
            node = graph[node_id]
            for name, value in list(node.get('inputs', {}).items()):
                if name in numeric and isinstance(value, (int, float)) and not isinstance(value, bool):
                    put(node_id, name, numeric[name])
            if node['class_type'] in IMAGE_INPUT_NODES and isinstance(node['inputs'].get('image'), str):
                images += 1
                put(node_id, 'image', f'IMAGE_{images}')
            if node['class_type'] in AUDIO_INPUT_NODES:
                field = 'audio' if isinstance(node['inputs'].get('audio'), str) else 'audio_file' if isinstance(node['inputs'].get('audio_file'), str) else None
                if field:
                    audio += 1
                    put(node_id, field, f'AUDIO_{audio}')
    for node_id in ids:
        for name, value in list(graph[node_id].get('inputs', {}).items()):
            if name in ('seed', 'noise_seed') and isinstance(value, (int, float)) and not isinstance(value, bool):
                put(node_id, name, 'SEED')
            elif name == 'filename_prefix' and isinstance(value, str):
                put(node_id, name, 'OUTPUT_PREFIX')
    if turbo:
        switches = [i for i in ids if graph[i]['class_type'] == 'PrimitiveBoolean'
                    and 'lightning' in str(graph[i].get('_meta', {}).get('title', '')).lower()]
        for node_id in switches:
            if graph[node_id]['inputs'].get('value') is not True:
                graph[node_id]['inputs']['value'] = True
                changes.append(f'node {node_id} (PrimitiveBoolean) value: Lightning LoRA turned on (fewer steps, faster, slightly softer)')
        if not switches:
            changes.append('WARNING: --turbo found no "Enable Lightning LoRA" switch; the workflow is unchanged there')
    found = placeholders_in(graph)
    missing = [t for t in ('PROMPT', 'WIDTH', 'HEIGHT', 'FRAMES', 'SEED', 'OUTPUT_PREFIX') if t not in found]
    if missing:
        changes.append('WARNING: no ' + ', '.join('{{' + t + '}}' for t in missing) + ' in the workflow; add them by hand where they belong')
    return graph, changes


def add_reference_slots(graph: dict, node_id: str, put: Callable[[str, str, str], None], changes: list[str]) -> None:
    """Point each reference slot of an R2V node at a load node with {{IMAGE_n}} or {{AUDIO_n}}.
    Slot ref_image_0 is <Picture 1> in the prompt and ref_audio_0 is <Audio 1>, matching the job's file order.
    Missing load nodes are added; slots a job does not fill are removed before it is queued."""
    inputs = graph[node_id]['inputs']
    dotted = not any(REF_IMAGE_INPUT.match(k) and not k.startswith('ref_images.') for k in inputs)

    def new_id() -> str:
        n = 9001
        while str(n) in graph:
            n += 1
        return str(n)
    for pattern, group, slot, count, loaders, field, token, label in (
        (REF_IMAGE_INPUT, 'ref_images', 'ref_image', MAX_REF_IMAGES, IMAGE_INPUT_NODES, 'image', 'IMAGE', 'LoadImage'),
        (REF_AUDIO_INPUT, 'ref_audios', 'ref_audio', MAX_REF_AUDIO, AUDIO_INPUT_NODES, 'audio', 'AUDIO', 'LoadAudio'),
    ):
        existing = {int(m.group(2)): key for key in inputs if (m := pattern.match(key))}
        added = []
        for index in range(count):
            key = existing.get(index, f'{group}.{slot}_{index}' if dotted else f'{slot}_{index}')
            value = inputs.get(key)
            if is_link(value):
                source = upstream(graph, str(value[0]), loaders)
                if source and isinstance(graph[source]['inputs'].get(field), str):
                    put(source, field, f'{token}_{index + 1}')
                else:
                    changes.append(f'WARNING: {key} of node {node_id} is not fed by a {label} node; give it {{{{{token}_{index + 1}}}}} by hand')
                continue
            loader = new_id()
            graph[loader] = {'class_type': label, 'inputs': {field: f'{{{{{token}_{index + 1}}}}}'}, '_meta': {'title': f'Sci-epo {slot.replace("_", " ")} {index + 1}'}}
            inputs[key] = [loader, 0]
            added.append(index + 1)
        if added:
            changes.append(f'node {node_id}: added {label} nodes for {{{{{token}_{added[0]}}}}}' + (f' to {{{{{token}_{added[-1]}}}}}' if len(added) > 1 else '')
                           + '; slots a job does not use are removed before it is queued')


# --------------------------------------------------------------------------- backends

def prompt_text(job: dict) -> str:
    return (f"# {job['output']} · {job['mode']} · {job['frames']} frames · {job['width']}x{job['height']} · seed {job['seed']}\n"
            f"# images: {', '.join(job['images']) or '-'} · audio: {', '.join(job['audio']) or '-'}\n\n{job['prompt']}\n")


class DryRunBackend:
    name = 'dry-run'
    reports_success = False

    def render(self, job: dict, out_dir: Path) -> dict:
        path = Path(out_dir) / f"{job['output']}.prompt.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(prompt_text(job), encoding='utf-8')
        log(f"dry run: wrote {path.name}")
        return {'jobId': job['id'], 'status': 'dry_run', 'file': path.name}


class CommandBackend:
    """Run a command template for each job. Values are shell-quoted; the command must write {output}."""
    name = 'command'
    reports_success = True

    def __init__(self, template: str, refs_dir: Path | None, timeout_s: float):
        self.template, self.refs_dir, self.timeout_s = template, refs_dir, timeout_s

    def render(self, job: dict, out_dir: Path) -> dict:
        out_dir = Path(out_dir)
        prompts = out_dir / '.prompts'
        prompts.mkdir(parents=True, exist_ok=True)
        prompt_file = prompts / f"{job['output']}.txt"
        prompt_file.write_text(job['prompt'], encoding='utf-8')
        output = out_dir / job['output']
        refs = self.refs_dir or out_dir
        values = {'prompt_file': str(prompt_file), 'output': str(output), 'frames': job['frames'], 'width': job['width'],
                  'height': job['height'], 'seed': job['seed'], 'mode': job['mode'], 'language': job.get('language', ''),
                  'images': ' '.join(str(refs / n) for n in job['images']), 'audio': ' '.join(str(refs / n) for n in job['audio'])}
        command = self.template.format_map({k: shlex.quote(str(v)) for k, v in values.items()})
        log(f"running command for {job['output']}")
        try:
            done = subprocess.run(command, shell=True, timeout=self.timeout_s, capture_output=True, text=True)
        except subprocess.TimeoutExpired as error:
            raise WorkerError(f'command timed out after {self.timeout_s:.0f} s') from error
        if done.returncode != 0:
            tail = (done.stderr or done.stdout or '').strip().splitlines()[-3:]
            raise WorkerError(f'command exited with {done.returncode}: {" | ".join(tail)}')
        return succeeded(job, output)


class ComfyUIBackend:
    """Queue an API-format workflow with placeholders on ComfyUI and download the first video it saves."""
    name = 'comfyui'
    reports_success = True

    def __init__(self, url: str, workflows: dict[str, dict], refs_dir: Path | None, timeout_s: float, poll_s: float = 5):
        self.url = url.rstrip('/')
        self.workflows, self.refs_dir, self.timeout_s, self.poll_s = workflows, refs_dir, timeout_s, poll_s
        self.client_id = uuid.uuid4().hex
        for mode, graph in workflows.items():
            if 'PROMPT' not in placeholders_in(graph):
                raise WorkerError(f'the {mode} workflow has no {{{{PROMPT}}}} placeholder; run prepare-workflow first')

    def upload(self, name: str) -> str:
        if not self.refs_dir:
            raise WorkerError(f'job needs reference file {name}; pass --refs with the folder that holds it')
        path = Path(self.refs_dir) / name
        if not path.is_file():
            raise WorkerError(f'reference file {name} is not in {self.refs_dir}')
        body, content_type = multipart({'type': 'input', 'overwrite': 'true'}, 'image', path)
        status, raw = http('POST', f'{self.url}/upload/image', body, {'content-type': content_type}, timeout=120)
        if status != 200:
            raise WorkerError(f'ComfyUI refused the upload of {name} (HTTP {status})')
        data = json.loads(raw.decode('utf-8'))
        return f"{data['subfolder']}/{data['name']}" if data.get('subfolder') else data['name']

    def render(self, job: dict, out_dir: Path) -> dict:
        graph = self.workflows.get(job['mode'])
        if graph is None:
            raise WorkerError(f"job {job['output']} is {job['mode']}, but no {job['mode']} workflow was given (--{'r2v-' if job['mode'] == 'r2v' else ''}workflow)")
        values: dict[str, Any] = {'PROMPT': job['prompt'], 'WIDTH': job['width'], 'HEIGHT': job['height'], 'FRAMES': job['frames'],
                                  'SEED': job['seed'], 'OUTPUT_PREFIX': f"sciepo/{Path(job['output']).stem}"}
        for index, name in enumerate(job['images'], 1):
            values[f'IMAGE_{index}'] = self.upload(name)
        for index, name in enumerate(job['audio'], 1):
            values[f'AUDIO_{index}'] = self.upload(name)
        graph = prune_missing_references(graph, set(values))
        used: set[str] = set()
        graph = substitute(graph, values, used)
        missing = [k for k in values if re.fullmatch(r'(IMAGE|AUDIO)_\d+', k) and k not in used]
        if missing:
            raise WorkerError(f"the {job['mode']} workflow has no slot for {', '.join('{{' + m + '}}' for m in missing)}")
        status, data = http_json('POST', f'{self.url}/prompt', {'prompt': graph, 'client_id': self.client_id})
        if status != 200 or not isinstance(data, dict) or 'prompt_id' not in data:
            detail = data.get('error', {}).get('message') if isinstance(data, dict) and isinstance(data.get('error'), dict) else data
            raise WorkerError(f'ComfyUI rejected the workflow (HTTP {status}): {str(detail)[:300]}')
        prompt_id = data['prompt_id']
        log(f"queued {job['output']} on ComfyUI as {prompt_id}")
        deadline = time.monotonic() + self.timeout_s
        while True:
            status, history = http_json('GET', f'{self.url}/history/{prompt_id}')
            entry = history.get(prompt_id) if status == 200 and isinstance(history, dict) else None
            if entry:
                state = entry.get('status', {})
                if state.get('status_str') == 'error':
                    messages = [m[1].get('exception_message', '') for m in state.get('messages', []) if isinstance(m, list) and len(m) == 2 and m[0] == 'execution_error' and isinstance(m[1], dict)]
                    raise WorkerError(f"ComfyUI failed: {' '.join(messages)[:300] or 'execution error'}")
                found = self.video_output(entry.get('outputs', {}))
                if found:
                    return self.download(found, job, Path(out_dir))
                if state.get('completed'):
                    raise WorkerError('ComfyUI finished without saving a video; check the save node of the workflow')
            if time.monotonic() > deadline:
                raise WorkerError(f'ComfyUI did not finish within {self.timeout_s:.0f} s')
            time.sleep(self.poll_s)

    @staticmethod
    def video_output(outputs: dict) -> dict | None:
        for node in outputs.values():
            if not isinstance(node, dict):
                continue
            for key in ('videos', 'gifs', 'images', 'video'):
                for item in node.get(key, []) or []:
                    if isinstance(item, dict) and str(item.get('filename', '')).lower().endswith(VIDEO_EXTENSIONS):
                        return item
        return None

    def download(self, item: dict, job: dict, out_dir: Path) -> dict:
        query = urllib.parse.urlencode({'filename': item['filename'], 'subfolder': item.get('subfolder', ''), 'type': item.get('type', 'output')})
        status, raw = http('GET', f'{self.url}/view?{query}', timeout=600)
        if status != 200 or not raw:
            raise WorkerError(f"cannot download {item['filename']} from ComfyUI (HTTP {status})")
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / job['output']
        tmp = path.with_suffix(path.suffix + '.part')
        tmp.write_bytes(raw)
        os.replace(tmp, path)
        log(f"saved {path}")
        return succeeded(job, path)


def render_one(backend: Any, job: dict, out_dir: Path) -> dict:
    try:
        return backend.render(job, out_dir)
    except WorkerError as error:
        log(f"FAILED {job['output']}: {error}")
        return failed(job, str(error))
    except Exception as error:  # a backend bug must not stop the whole batch
        log(f"FAILED {job['output']}: unexpected {type(error).__name__}: {error}")
        return failed(job, f'unexpected {type(error).__name__}: {error}')


# --------------------------------------------------------------------------- modes

def run_package(package: dict, backend: Any, out_dir: Path, force: bool = False) -> Results:
    results = Results(out_dir, package['batch']['id'])
    jobs = package['jobs']
    for index, job in enumerate(jobs, 1):
        if not force and (results.done(job['id']) or job.get('status') == 'succeeded'):
            log(f"[{index}/{len(jobs)}] skip {job['output']}: already succeeded")
            continue
        log(f"[{index}/{len(jobs)}] render {job['output']} ({job['mode']}, {job['frames']} frames)")
        results.record(render_one(backend, job, out_dir))
    states = [e['status'] for e in results.entries.values()]
    log(f"done: {states.count('succeeded')} succeeded, {states.count('failed')} failed, {states.count('dry_run')} dry run. Results: {results.path}")
    return results


class SciEpo:
    """Client of the Sci-epo worker API. The token is sent only to this server; redirects are refused."""

    def __init__(self, server: str, token: str, timeout: float = 30):
        parts = urllib.parse.urlsplit(server)
        if parts.scheme not in ('https', 'http') or not parts.netloc:
            raise WorkerError('--server must be the Sci-epo address, for example https://studio.example.com')
        if parts.scheme == 'http' and parts.hostname not in ('127.0.0.1', 'localhost'):
            raise WorkerError('use https for a remote Sci-epo server; plain http is only for this computer')
        self.base = f'{parts.scheme}://{parts.netloc}{parts.path.rstrip("/")}/api/worker/v1'
        self.headers = {'authorization': f'Bearer {token}'}
        self.timeout = timeout

    def call(self, method: str, path: str, payload: Any = None) -> tuple[int, Any]:
        return http_json(method, f'{self.base}/{path}', payload, self.headers, self.timeout)

    def hello(self) -> str:
        status, data = self.call('GET', 'hello')
        if status == 401:
            raise WorkerError('Sci-epo refused the worker token (wrong or revoked)')
        if status != 200 or not isinstance(data, dict):
            raise WorkerError(f'Sci-epo answered HTTP {status}; check --server')
        return str(data.get('worker', ''))


def run_pull(client: SciEpo, backend: Any, out_dir: Path, wait: bool, poll_s: float, heartbeat_s: float = 300, max_jobs: int | None = None) -> int:
    if not backend.reports_success:
        raise WorkerError('dry-run never reports success; use it with the package mode')
    log(f'connected to Sci-epo as worker "{client.hello()}"')
    done = 0
    while max_jobs is None or done < max_jobs:
        status, data = client.call('POST', 'claim', {})
        if status == 204:
            if not wait:
                log('no queued jobs left')
                break
            time.sleep(poll_s)
            continue
        if status != 200 or not isinstance(data, dict):
            raise WorkerError(f'claim failed with HTTP {status}: {data}')
        job = validate_job(data.get('job'))
        batch_id = str(data.get('batch', {}).get('id', 'pull'))
        if not re.fullmatch(r'[A-Za-z0-9-]{1,100}', batch_id):
            raise WorkerError('Sci-epo sent an invalid batch id')
        # One folder per batch, so results.json of different batches never overwrite each other.
        batch_dir = Path(out_dir) / batch_id
        results = Results(batch_dir, batch_id)
        stop = threading.Event()

        def beat() -> None:
            while not stop.wait(heartbeat_s):
                code, _ = client.call('POST', f"jobs/{job['id']}/heartbeat", {})
                if code == 410:
                    log(f"Sci-epo says the batch of {job['output']} is no longer current; it will be reported when it ends")
                if code in (409, 410):
                    return
        thread = threading.Thread(target=beat, daemon=True)
        thread.start()
        log(f"claimed {job['output']} ({job['mode']}, {job['frames']} frames)")
        entry = render_one(backend, job, batch_dir)
        stop.set()
        results.record(entry)
        payload = {k: v for k, v in entry.items() if k in ('status', 'file', 'seconds', 'bytes', 'sha256', 'error')}
        code, answer = client.call('POST', f"jobs/{job['id']}/result", payload)
        if code != 200:
            log(f"Sci-epo did not accept the result of {job['output']} (HTTP {code}): {answer}")
        done += 1
    return done


class ServeState:
    def __init__(self, backend: Any, out_dir: Path):
        self.backend, self.out_dir = backend, Path(out_dir)
        self.batches: dict[str, Results] = {}
        self.queue: list[tuple[str, dict]] = []
        self.lock = threading.Condition()
        threading.Thread(target=self.loop, daemon=True).start()

    def accept(self, package: dict) -> int:
        batch_id = package['batch']['id']
        with self.lock:
            results = self.batches.setdefault(batch_id, Results(self.out_dir / batch_id, batch_id))
            queued = {job['id'] for b, job in self.queue if b == batch_id}
            added = [job for job in package['jobs'] if not results.done(job['id']) and job['id'] not in queued and job.get('status') != 'succeeded']
            self.queue.extend((batch_id, job) for job in added)
            self.lock.notify()
        log(f'accepted batch {batch_id}: {len(added)} jobs queued')
        return len(added)

    def loop(self) -> None:
        while True:
            with self.lock:
                while not self.queue:
                    self.lock.wait()
                batch_id, job = self.queue.pop(0)
                results = self.batches[batch_id]
            results.record(render_one(self.backend, job, results.path.parent))


def make_handler(state: ServeState, key: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'sciepo-worker'

        def reply(self, status: int, payload: Any) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('content-type', 'application/json; charset=utf-8')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def authorized(self) -> bool:
            sent = self.headers.get('authorization', '')
            if secrets.compare_digest(sent.encode(), f'Bearer {key}'.encode()):
                return True
            self.reply(401, {'error': 'wrong worker key'})
            return False

        def do_GET(self) -> None:  # noqa: N802 - http.server naming
            if self.path == '/v1/health':
                return self.reply(200, {'ok': True})
            match = re.fullmatch(r'/v1/batches/([A-Za-z0-9-]{1,100})/results', self.path)
            if not self.authorized():
                return None
            if not match:
                return self.reply(404, {'error': 'not found'})
            results = state.batches.get(match.group(1))
            return self.reply(200, results.manifest() if results else {'format': RESULTS_FORMAT, 'version': 1, 'batchId': match.group(1), 'results': []})

        def do_POST(self) -> None:  # noqa: N802
            if not self.authorized():
                return None
            if self.path != '/v1/batches':
                return self.reply(404, {'error': 'not found'})
            length = int(self.headers.get('content-length') or 0)
            if length <= 0 or length > 20_000_000:
                return self.reply(413, {'error': 'package missing or too large'})
            try:
                package = check_package(json.loads(self.rfile.read(length).decode('utf-8')))
            except (ValueError, WorkerError) as error:
                return self.reply(400, {'error': str(error)})
            return self.reply(200, {'batchId': package['batch']['id'], 'jobs': state.accept(package)})

        def log_message(self, fmt: str, *args: Any) -> None:
            log('http ' + fmt % args)
    return Handler


# --------------------------------------------------------------------------- command line

def load_workflow(path: str | None) -> dict | None:
    if not path:
        return None
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise WorkerError(f'cannot read workflow {path}: {error}') from error


def make_backend(args: argparse.Namespace) -> Any:
    refs = Path(args.refs) if getattr(args, 'refs', None) else None
    if args.backend == 'dry-run':
        return DryRunBackend()
    if args.backend == 'command':
        if not args.command:
            raise WorkerError('--command is required with the command backend')
        return CommandBackend(args.command, refs, args.timeout)
    workflows = {mode: graph for mode, graph in (('t2va', load_workflow(args.workflow)), ('r2v', load_workflow(args.r2v_workflow))) if graph is not None}
    if not workflows:
        raise WorkerError('--workflow (T2VA) and/or --r2v-workflow is required with the comfyui backend')
    return ComfyUIBackend(args.comfy_url, workflows, refs, args.timeout)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog='sciepo_worker.py', description='Render Sci-epo jobs with MiniMax H3.')
    modes = root.add_subparsers(dest='mode', required=True)

    def backend_options(p: argparse.ArgumentParser) -> None:
        p.add_argument('--out', required=True, help='output folder for videos and results.json, e.g. a Google Drive folder')
        p.add_argument('--backend', choices=('comfyui', 'command', 'dry-run'), default='comfyui')
        p.add_argument('--comfy-url', default='http://127.0.0.1:8188')
        p.add_argument('--workflow', help='ComfyUI API-format workflow with placeholders for T2VA jobs')
        p.add_argument('--r2v-workflow', help='ComfyUI API-format workflow with placeholders for R2V jobs')
        p.add_argument('--refs', help='folder with the reference images and voice samples named in the jobs')
        p.add_argument('--command', help='command template for the command backend, e.g. "python h3.py --prompt-file {prompt_file} --out {output}"')
        p.add_argument('--timeout', type=float, default=3 * 3600, help='seconds allowed per job (default 3 hours)')

    package = modes.add_parser('package', help='render a job package file')
    package.add_argument('--package', required=True)
    package.add_argument('--force', action='store_true', help='render jobs that already succeeded')
    backend_options(package)

    pull = modes.add_parser('pull', help='claim jobs from a Sci-epo server')
    pull.add_argument('--server', required=True)
    pull.add_argument('--token', default=os.environ.get('SCIEPO_WORKER_TOKEN'), help='worker token (default: $SCIEPO_WORKER_TOKEN)')
    pull.add_argument('--wait', action='store_true', help='keep polling when the queue is empty')
    pull.add_argument('--poll', type=float, default=30)
    backend_options(pull)

    serve = modes.add_parser('serve', help='accept job packages pushed by Sci-epo')
    serve.add_argument('--host', default='127.0.0.1')
    serve.add_argument('--port', type=int, default=8765)
    serve.add_argument('--key', default=os.environ.get('SCIEPO_WORKER_KEY'), help='key Sci-epo must send (default: $SCIEPO_WORKER_KEY, or a new random key)')
    backend_options(serve)

    prepare = modes.add_parser('prepare-workflow', help='add placeholders to a workflow exported with Export (API)')
    prepare.add_argument('--input', required=True)
    prepare.add_argument('--output', required=True)
    prepare.add_argument('--turbo', action='store_true', help='turn on the template\'s Lightning LoRA switch: fewer steps, faster test renders')
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.mode == 'prepare-workflow':
            graph, changes = prepare_workflow(load_workflow(args.input) or {}, turbo=args.turbo)
            Path(args.output).write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding='utf-8')
            for line in changes:
                log(line)
            log(f'wrote {args.output}; check each change before rendering')
            return 0
        backend = make_backend(args)
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        if args.mode == 'package':
            results = run_package(load_package(Path(args.package)), backend, out, args.force)
            return 1 if any(e['status'] == 'failed' for e in results.entries.values()) else 0
        if args.mode == 'pull':
            if not args.token:
                raise WorkerError('a worker token is required: --token or $SCIEPO_WORKER_TOKEN')
            run_pull(SciEpo(args.server, args.token), backend, out, args.wait, args.poll)
            return 0
        key = args.key or secrets.token_urlsafe(24)
        if len(key) < 8:
            raise WorkerError('the worker key needs at least 8 characters')
        httpd = ThreadingHTTPServer((args.host, args.port), make_handler(ServeState(backend, out), key))
        log(f'serving on http://{args.host}:{args.port}; paste this key into Sci-epo: {key}')
        httpd.serve_forever()
        return 0
    except WorkerError as error:
        log(f'error: {error}')
        return 2
    except KeyboardInterrupt:
        log('stopped')
        return 130


if __name__ == '__main__':
    sys.exit(main())
