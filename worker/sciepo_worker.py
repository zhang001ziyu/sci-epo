#!/usr/bin/env python3
"""Sci-epo render worker for MiniMax H3.

Sci-epo plans render jobs from an adopted shot list: one job is one clip in one voice language,
with its H3 prompt, frame count, size, seed and reference files. This worker renders them.

Modes
  session           run a Sci-epo render session: the code comes from $SCIEPO_SESSION
  package           render a job package file downloaded from Sci-epo
  pull              claim jobs from a Sci-epo server with a worker token
  serve             accept job packages over HTTP, for a tunnel from Colab to Sci-epo
  prepare-workflow  add placeholders to a ComfyUI workflow exported in API format
  speech            transcribe one video with faster-whisper (session QA runs it)

Backends (package, pull and serve)
  comfyui   queue an API-format workflow on a ComfyUI server
  command   run your own command for each job
  dry-run   write the prompts only; never reports success

In package, pull and serve modes, videos and results.json are written to the output folder and nothing is
uploaded except job status. A session sets up the pinned stack, renders takes, checks them and uploads the
videos and QA files to Sci-epo's media store.
The core is standard library only; Python 3.10 or later. Optional packages are imported only when used.
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import importlib
import importlib.util
import json
import math
import os
import platform
import re
import secrets
import shlex
import shutil
import signal
import struct
import subprocess
import sys
import textwrap
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from http.client import HTTPException
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


class NetworkError(WorkerError):
    """Sci-epo or ComfyUI could not be reached, or the connection broke."""


# Anything that looks like a Sci-epo session or worker token is replaced before a line is printed or sent.
TOKEN_TEXT = re.compile(r'sciepo_(?:ss|wk)_[A-Za-z0-9_-]{20,}')


def scrub(text: Any) -> str:
    return TOKEN_TEXT.sub('[token]', str(text))


def log(message: str) -> None:
    line = f'[sciepo-worker] {scrub(message)}'
    try:
        print(line, flush=True)
    except UnicodeEncodeError:  # a console that cannot show every character
        print(line.encode('ascii', 'replace').decode('ascii'), flush=True)


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


def find_tool(name: str) -> str | None:
    """ffmpeg or ffprobe: $SCIEPO_FFMPEG or $SCIEPO_FFPROBE, then the folder of $SCIEPO_FFMPEG, then PATH."""
    named = os.environ.get(f'SCIEPO_{name.upper()}')
    if named and Path(named).is_file():
        return named
    base = os.environ.get('SCIEPO_FFMPEG')
    if base and name != 'ffmpeg':
        sibling = Path(base).with_name(name + Path(base).suffix)
        if sibling.is_file():
            return str(sibling)
    return shutil.which(name)


def probe_seconds(path: Path) -> float | None:
    """Duration from ffprobe when it is installed (Colab has it); otherwise None."""
    exe = find_tool('ffprobe')
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
    except (urllib.error.URLError, OSError, HTTPException) as error:
        raise NetworkError(f'cannot reach {urllib.parse.urlsplit(url).netloc}: {getattr(error, "reason", error)}') from error


def http_upload(url: str, path: Path, headers: dict, timeout: float = 300) -> tuple[int, bytes]:
    """PUT a file as the raw body, streamed from disk with its Content-Length. Redirects are refused."""
    size = Path(path).stat().st_size
    try:
        with open(path, 'rb') as body:
            request = urllib.request.Request(url, data=body, method='PUT', headers={**headers, 'content-length': str(size)})
            with _opener.open(request, timeout=timeout) as response:
                return response.status, response.read()
    except urllib.error.HTTPError as error:
        try:
            return error.code, error.read() if error.fp else b''
        finally:
            error.close()
    except (urllib.error.URLError, OSError, HTTPException) as error:
        raise NetworkError(f'cannot reach {urllib.parse.urlsplit(url).netloc}: {getattr(error, "reason", error)}') from error


def http_download(url: str, dest: Path, headers: dict, limit: int, timeout: float = 120) -> tuple[int, str, int]:
    """GET a file to dest, hashing it while it streams; returns the status, the SHA-256 and the size."""
    dest = Path(dest)
    part = dest.with_name(dest.name + '.part')
    try:
        with _opener.open(urllib.request.Request(url, headers=headers), timeout=timeout) as response:
            digest, size = hashlib.sha256(), 0
            with open(part, 'wb') as out:
                while chunk := response.read(1 << 20):
                    size += len(chunk)
                    if size > limit:
                        raise WorkerError(f'{dest.name} is larger than Sci-epo said ({limit} bytes)')
                    digest.update(chunk)
                    out.write(chunk)
            os.replace(part, dest)
            return response.status, digest.hexdigest(), size
    except urllib.error.HTTPError as error:
        try:
            return error.code, '', 0
        finally:
            error.close()
    except (urllib.error.URLError, OSError, HTTPException) as error:
        raise NetworkError(f'cannot reach {urllib.parse.urlsplit(url).netloc}: {getattr(error, "reason", error)}') from error
    finally:
        part.unlink(missing_ok=True)


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
        # Set by a session while a take renders; when it is set, waiting for ComfyUI stops.
        self.cancel: threading.Event | None = None
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
        if 'steps' in job:
            # Session takes carry their sampling steps and turbo switch; the stack workflows read them.
            # Version 1 jobs have neither, and their workflows have no such placeholders.
            values['STEPS'] = job['steps']
            values['LORA_STRENGTH'] = 1.0 if job.get('turbo') else 0.0
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
            if self.cancel is not None and self.cancel.is_set():
                raise WorkerError('the render was interrupted')
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


# --------------------------------------------------------------------------- render sessions: helpers

SESSION_FORMAT = 'sciepo-session'
SESSION_TOKEN = re.compile(r'^sciepo_ss_[A-Za-z0-9_-]{43}$')
SESSION_ENDS = ('queue_empty', 'budget', 'stopped', 'not_current', 'failures', 'error', 'lost', 'expired')
NORMAL_ENDS = ('queue_empty', 'stopped', 'budget', 'not_current')
UPLOAD_TYPES = {'video': 'video/mp4', 'contact-sheet': 'image/jpeg', 'keyframe': 'image/jpeg', 'qa': 'application/json'}
RETRYABLE = frozenset({408, 425, 429, 500, 502, 503, 504, 507})
ID_TEXT = re.compile(r'^[A-Za-z0-9._-]{1,100}$')
SHOT_ID = re.compile(r'^[A-Za-z0-9_-]{1,40}$')
SHA256_HEX = re.compile(r'^[0-9a-f]{64}$')
COMMIT = re.compile(r'^[0-9a-f]{40}$')
HF_REPO = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$')
MODEL_PATH = re.compile(r'^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,250}$')
SPEECH_MARK = 'SCIEPO_SPEECH '
SIMPLIFIED_PROMPT = '以下是普通话的句子。'
MB = 1024 * 1024
# Times in seconds. They are module values so tests can shorten them.
UPLOAD_WINDOW_S = 600.0    # all uploads and the result of one take
UPLOAD_BACKOFF_S = 2.0     # first retry delay, doubled up to 60 s
CLAIM_RETRY_S = 300.0      # how long a claim is retried while Sci-epo cannot be reached
DOWNLOAD_EVENT_S = 15.0    # progress events while model files download
COMFY_START_S = 600.0      # how long a new ComfyUI may take to answer
COMFY_POLL_S = 5.0         # ComfyUI history polling
BUDGET_GRACE_S = 300.0     # a take still rendering this long after the budget is interrupted
TAKE_TIMEOUT_S = 3 * 3600.0


class SessionGone(WorkerError):
    """Sci-epo no longer accepts the session token: the session ended or expired."""


class SessionEnded(Exception):
    """The session ends early with a reason, for example a stop requested during setup."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason, self.message = reason, message


class Undelivered(WorkerError):
    """A take's video or result did not reach Sci-epo."""


def parse_session_code(code: str) -> tuple[str, str]:
    """Split a session code (<server origin>#<token>) and check both parts before anything is sent."""
    server, sep, token = (code or '').strip().partition('#')
    if not sep or not server:
        raise WorkerError('SCIEPO_SESSION must hold the session code from Sci-epo: the server address, "#" and the token')
    if not SESSION_TOKEN.fullmatch(token):
        raise WorkerError('the token in SCIEPO_SESSION is not a Sci-epo session token (sciepo_ss_ and 43 characters)')
    parts = urllib.parse.urlsplit(server)
    if parts.scheme not in ('https', 'http') or not parts.hostname or parts.query or parts.fragment or parts.username or parts.password:
        raise WorkerError('the session code must start with the Sci-epo address, for example https://studio.example.com')
    if parts.scheme == 'http' and parts.hostname not in ('127.0.0.1', 'localhost'):
        raise WorkerError('the Sci-epo address in the session code must use https; plain http is only for this computer')
    return server.rstrip('/'), token


def program_sha256() -> str:
    """SHA-256 of this program file, as Sci-epo states it for the program it serves."""
    return file_sha256(Path(__file__).resolve())


def parse_time(value: Any) -> float | None:
    """Epoch seconds of an ISO time such as 2026-11-12T08:00:00.000Z (Python 3.10 needs the Z spelled out)."""
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return (moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)).timestamp()


def clock(epoch: float | None) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime('%H:%M UTC') if epoch else '?'


def format_bytes(count: float) -> str:
    for unit, size in (('GB', 1e9), ('MB', 1e6), ('KB', 1e3)):
        if count >= size:
            return f'{count / size:.1f} {unit}'
    return f'{int(count)} B'


def error_text(data: Any) -> str:
    if isinstance(data, dict) and isinstance(data.get('error'), str):
        return scrub(data['error'])[:300]
    return scrub(str(data))[:300]


def parse_gpu_line(text: str) -> tuple[str, float] | None:
    """The first GPU of `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`: name and GiB."""
    for line in (text or '').splitlines():
        name, _, memory = line.rpartition(',')
        try:
            mib = float(memory.strip())
        except ValueError:
            continue
        if name.strip():
            return name.strip(), round(mib / 1024, 1)
    return None


def query_gpu() -> tuple[str, float] | None:
    """Name and memory of GPU 0 from nvidia-smi, or None without an NVIDIA GPU. Tests replace this function."""
    exe = shutil.which('nvidia-smi')
    if not exe:
        return None
    try:
        out = subprocess.run([exe, '--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
                             capture_output=True, text=True, timeout=60, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_gpu_line(out)


def untested_gpu(stacks: list[dict], modes: list[str], name: str, vram_gb: float) -> list[str]:
    """Stack and mode pairs that list no tested GPU matching this one; empty when the GPU is tested for all of them.
    A tested entry matches when its name is part of the reported name, the memory is enough and it lists the mode."""
    missing = []
    for stack in stacks:
        tested = [g for g in stack.get('testedGpus') or [] if isinstance(g, dict)]
        for mode in modes:
            if not any(isinstance(g.get('name'), str) and g['name'] in name and vram_gb >= float(g.get('minVramGb') or 0)
                       and mode in (g.get('modes') or []) for g in tested):
                missing.append(f"{stack.get('id', '?')} {mode}")
    return missing


def dir_bytes(root: Path) -> int:
    """Bytes of the files under root, without following links."""
    total, pending = 0, [str(root)]
    while pending:
        try:
            with os.scandir(pending.pop()) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            pending.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def run_command(command: list[Any], cwd: Path | None = None, timeout: float = 1800) -> str:
    """Run a setup command; on failure, raise with the last lines it printed."""
    command = [str(part) for part in command]
    name = command[2] if command[1:2] == ['-m'] and len(command) > 2 else Path(command[0]).name
    log('$ ' + ' '.join(shlex.quote(part) for part in [Path(command[0]).name, *command[1:]]))
    try:
        done = subprocess.run(command, cwd=str(cwd) if cwd else None, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise WorkerError(f'{name} did not finish within {timeout / 60:.0f} minutes') from error
    except OSError as error:
        raise WorkerError(f'cannot run {name}: {error}') from error
    if done.returncode != 0:
        tail = ' | '.join((done.stderr or done.stdout or '').strip().splitlines()[-4:])
        raise WorkerError(f'{name} exited with {done.returncode}: {tail[:400]}')
    return done.stdout


def model_files(stacks: list[dict], modes: list[str]) -> list[dict]:
    """The model files of the stacks for the modes in use: `common` plus each mode, each file once."""
    files, seen = [], set()
    for stack in stacks:
        groups = stack.get('files') if isinstance(stack.get('files'), dict) else {}
        for key in ('common', *modes):
            for item in groups.get(key) or []:
                repo, path, target = item.get('repo'), item.get('path'), item.get('target')
                if not (isinstance(repo, str) and HF_REPO.fullmatch(repo) and isinstance(path, str) and MODEL_PATH.fullmatch(path)
                        and (target is None or (isinstance(target, str) and MODEL_PATH.fullmatch(target)))):
                    raise WorkerError(f"stack {stack.get('id', '?')} lists an invalid model file: {str(item)[:120]}")
                dest = target or path
                if dest not in seen:
                    seen.add(dest)
                    files.append({'repo': repo, 'path': path, 'target': target, 'dest': dest, 'gb': item.get('gb')})
    return files


# --------------------------------------------------------------------------- render sessions: placeholder takes and QA

FONT_FILES = {
    'nt': ('msyh.ttc', 'msyh.ttf', 'simhei.ttf', 'simsun.ttc', 'arial.ttf', 'segoeui.ttf'),
    'darwin': ('/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Medium.ttc', '/Library/Fonts/Arial Unicode.ttf',
               '/System/Library/Fonts/Helvetica.ttc'),
    'posix': ('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
              '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
              '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
              '/usr/share/fonts/TTF/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'),
}
SAFE_FILTER_PATH = re.compile(r'^[A-Za-z0-9._/-]+$')


def font_file() -> Path | None:
    """A font for drawn text: $SCIEPO_CAPTION_FONT, a font that also covers Chinese, or any common sans font."""
    named = os.environ.get('SCIEPO_CAPTION_FONT')
    if named and Path(named).is_file():
        return Path(named)
    if os.name == 'nt':
        fonts = Path(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts')
        candidates = [fonts / name for name in FONT_FILES['nt']]
    else:
        candidates = [Path(p) for p in FONT_FILES['darwin' if sys.platform == 'darwin' else 'posix']]
    try:  # matplotlib ships DejaVu Sans, so Colab always has one font
        spec = importlib.util.find_spec('matplotlib')
        for location in (spec.submodule_search_locations or []) if spec else []:
            candidates.append(Path(location, 'mpl-data', 'fonts', 'ttf', 'DejaVuSans.ttf'))
    except (ImportError, ValueError):
        pass
    return next((c for c in candidates if c.is_file()), None)


def font_option(cwd: Path) -> str | None:
    """The drawtext font option for ffmpeg running in cwd: a relative fontfile, '' for fontconfig's default font,
    or None when no text can be drawn. Paths stay relative, so a Windows drive colon never enters a filter string."""
    font = font_file()
    if font is None:
        return None if os.name == 'nt' else ''  # without a font file, drawtext on Windows builds can crash
    try:
        relative = Path(os.path.relpath(font, cwd)).as_posix()
    except ValueError:  # another drive
        relative = ''
    if not SAFE_FILTER_PATH.fullmatch(relative):
        copy = Path(cwd) / f'sciepo-font{font.suffix.lower()}'
        if not copy.is_file():
            shutil.copyfile(font, copy)
        relative = copy.name
    return f'fontfile={relative}:'


def drawtext(font: str, textfile: str, size: int, position: str, enable: str | None = None) -> str:
    """One drawtext filter that shows a text file literally (no % expansion), white on a dark box."""
    option = (f'drawtext={font}textfile={textfile}:expansion=none:fontsize={size}:fontcolor=white:box=1:boxcolor=black@0.6:'
              f'boxborderw={max(3, size // 3)}:{position}')
    return option + (f':enable={enable}' if enable else '')


def is_cjk_text(text: str) -> bool:
    return any('\u3000' <= ch <= '\u9fff' or '\uac00' <= ch <= '\ud7af' or '\uff00' <= ch <= '\uffef' for ch in text)


def wrap_line(text: str, width: int, size: int, max_lines: int = 6) -> str:
    """Wrap a line for a frame of this width: about 0.9 em per CJK character and 0.55 em per Latin one."""
    if is_cjk_text(text):
        per = max(6, int(width * 0.86 / size))
        lines = [text[i:i + per] for i in range(0, len(text), per)]
    else:
        lines = textwrap.wrap(text, max(12, int(width * 0.86 / (size * 0.55)))) or ['']
    if len(lines) > max_lines:
        lines = lines[:max_lines - 1] + [lines[max_lines - 1].rstrip() + '…']
    return '\n'.join(lines)


def render_rehearsal(take: dict, output: Path, note: str = '') -> Path:
    """A placeholder take of the planned length: ffmpeg's test picture, a tone and the expected lines as text.
    H.264 yuv420p and AAC with the index in front, as Sci-epo's media store and browsers expect."""
    ffmpeg = find_tool('ffmpeg')
    if not ffmpeg:
        raise WorkerError('ffmpeg is not installed; a rehearsal makes its placeholder takes with ffmpeg')
    output = Path(output)
    folder, stem = output.parent, output.stem
    folder.mkdir(parents=True, exist_ok=True)
    width, height, frames = int(take['width']), int(take['height']), int(take['frames'])
    fps = float(take.get('fps') or 24)
    seconds = frames / fps
    texts = [str(line.get('text', '')).strip() for line in take.get('expectedLines') or [] if isinstance(line, dict)]
    texts = [text for text in texts if text]
    filters: list[str] = []
    font = font_option(folder)
    if font is not None:
        title_size, line_size = max(12, round(width / 26)), max(12, round(width / 22))
        title = folder / f'{stem}-title.txt'
        title.write_text(f"REHEARSAL · {take.get('output', stem)} · take {take.get('n', 1)}", encoding='utf-8')
        filters.append(drawtext(font, title.name, title_size, 'x=(w-text_w)/2:y=h*0.05'))
        share = seconds / max(1, len(texts))
        for index, text in enumerate(texts):
            name = f'{stem}-line-{index + 1}.txt'
            (folder / name).write_text(wrap_line(text, width, line_size), encoding='utf-8')
            filters.append(drawtext(font, name, line_size, f'x=(w-text_w)/2:y=h*0.68:line_spacing={line_size // 3}',
                                    f'between(t\\,{index * share:.3f}\\,{(index + 1) * share:.3f})'))
    head = [ffmpeg, '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', f'testsrc2=size={width}x{height}:rate={fps:g}',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000']
    tail = ['-t', f'{seconds:.6f}', '-frames:v', str(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-ac', '2', *(['-metadata', f'comment={note}'] if note else []), '-movflags', '+faststart', output.name]
    problem = ''
    for command in ([head + ['-vf', ','.join(filters)] + tail, head + tail] if filters else [head + tail]):
        try:
            done = subprocess.run(command, cwd=str(folder), capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=max(120.0, seconds * 30))
        except subprocess.TimeoutExpired:
            problem = 'ffmpeg timed out'
            continue
        if done.returncode == 0 and output.is_file() and output.stat().st_size > 0:
            return output
        problem = ' | '.join((done.stderr or '').strip().splitlines()[-2:]) or f'exit code {done.returncode}'
        if filters:
            log(f'drawing text failed ({problem[:200]}); making the placeholder without text')
    raise WorkerError(f'ffmpeg could not make the rehearsal take: {problem[:300]}')


def tag_video(path: Path, note: str) -> Path:
    """Copy the streams into a new MP4 with the note as its comment and the index in front. Sci-epo stores media
    by hash per project, so the note keeps two sessions from sharing one file. Without ffmpeg the file stays as it is."""
    ffmpeg = find_tool('ffmpeg')
    path = Path(path)
    if not ffmpeg:
        return path
    tagged = path.with_name(path.stem + '.tagged.mp4')
    try:
        done = subprocess.run([ffmpeg, '-y', '-v', 'error', '-i', path.name, '-map', '0:v', '-map', '0:a?', '-c', 'copy', '-metadata', f'comment={note}',
                               '-movflags', '+faststart', tagged.name], cwd=str(path.parent), capture_output=True, timeout=600)
        if done.returncode == 0 and tagged.is_file() and tagged.stat().st_size > 0:
            os.replace(tagged, path)
    except (OSError, subprocess.SubprocessError):
        pass
    tagged.unlink(missing_ok=True)
    return path


def mark_jpeg(path: Path, note: str) -> None:
    """Add a JPEG comment segment after the JFIF header, for the same reason as tag_video."""
    data = Path(path).read_bytes()
    if data[:2] != b'\xff\xd8':
        return
    at = 2
    if data[2:4] == b'\xff\xe0' and len(data) >= 6:
        at = 4 + struct.unpack('>H', data[4:6])[0]
    text = note.encode('utf-8')[:60000]
    Path(path).write_bytes(data[:at] + b'\xff\xfe' + struct.pack('>H', len(text) + 2) + text + data[at:])


def ffprobe_info(path: Path) -> dict | None:
    """ffprobe's format and streams, None without ffprobe; raises when the file cannot be read."""
    exe = find_tool('ffprobe')
    if not exe:
        return None
    try:
        done = subprocess.run([exe, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', str(path)],
                              capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
    except (OSError, subprocess.SubprocessError) as error:
        raise WorkerError(f'ffprobe failed: {error}') from error
    if done.returncode != 0:
        raise WorkerError(f"ffprobe cannot read {Path(path).name}: {(done.stderr or '').strip().splitlines()[-1:] or done.returncode}")
    try:
        return json.loads(done.stdout)
    except ValueError as error:
        raise WorkerError('ffprobe printed no JSON') from error


def parse_rate(value: Any) -> float | None:
    try:
        num, _, den = str(value).partition('/')
        rate = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        return None
    return rate if rate > 0 and math.isfinite(rate) else None


def number(text: str | None) -> float | None:
    try:
        value = float(text) if text is not None else None
    except ValueError:
        return None
    return value if value is not None and math.isfinite(value) else None


def measure_audio(path: Path, duration: float) -> dict | None:
    """Integrated loudness, true peak and loudness range (ebur128), and silences of 2 s or more below -45 dB, in one pass."""
    ffmpeg = find_tool('ffmpeg')
    if not ffmpeg:
        return None
    try:
        done = subprocess.run([ffmpeg, '-nostats', '-hide_banner', '-i', str(path), '-vn', '-af',
                               'ebur128=peak=true:framelog=verbose,silencedetect=noise=-45dB:d=2', '-f', 'null', '-'],
                              capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=600)
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    text = done.stderr or ''
    summary = text[text.rfind('Summary:'):] if 'Summary:' in text else ''

    def find(pattern: str) -> float | None:
        found = re.search(pattern, summary, re.M)
        return number(found.group(1)) if found else None
    silences, start = [], None
    for found in re.finditer(r'silence_start: (\S+)|silence_end: (\S+)', text):
        if found.group(1) is not None:
            start = number(found.group(1))
        elif start is not None:
            end = number(found.group(2))
            if end is not None:
                silences.append({'start': round(max(0.0, start), 2), 'end': round(end, 2), 'duration': round(end - max(0.0, start), 2)})
            start = None
    if start is not None and duration > start:  # a silence that lasts to the end of the file
        silences.append({'start': round(max(0.0, start), 2), 'end': round(duration, 2), 'duration': round(duration - max(0.0, start), 2)})
    return {'integrated': find(r'^\s*I:\s*(\S+)\s*LUFS'), 'truePeak': find(r'^\s*Peak:\s*(\S+)\s*dBFS'),
            'range': find(r'^\s*LRA:\s*(\S+)\s*LU\b'), 'silences': silences}


def make_contact_sheet(video: Path, take: dict, duration: float) -> Path | None:
    """One frame per second, 180 px wide, eight across, with the shot ID drawn on the tile where each shot starts.
    Without a usable font, or when drawing fails, the sheet has no labels."""
    ffmpeg = find_tool('ffmpeg')
    video = Path(video)
    if not ffmpeg or duration <= 0:
        return None
    folder, stem = video.parent, video.stem
    tiles = max(1, int(duration + 0.5))  # ffmpeg's fps=1 gives one frame per started second, rounded to nearest
    out = folder / f'{stem}-sheet.jpg'
    marks: dict[int, list[str]] = {}
    for shot in take.get('shots') or []:
        if not isinstance(shot, dict) or not isinstance(shot.get('shotId'), str):
            continue
        start = number(str(shot.get('start', 0)))
        if start is not None:
            marks.setdefault(min(tiles - 1, max(0, math.ceil(start - 1e-6))), []).append(shot['shotId'])
    base, tile = 'fps=1,scale=180:-2', f'tile=8x{math.ceil(tiles / 8)}:padding=2:color=black'
    labels: list[str] = []
    font = font_option(folder) if marks else None
    if font is not None:
        for index, (tile_index, names) in enumerate(sorted(marks.items())):
            name = f'{stem}-sheet-label-{index + 1}.txt'
            (folder / name).write_text(' / '.join(names), encoding='utf-8')
            labels.append(drawtext(font, name, 16, 'x=6:y=6', f'eq(n\\,{tile_index})'))
    for chain in ([base, *labels, tile], [base, tile]) if labels else ([base, tile],):
        out.unlink(missing_ok=True)
        try:
            done = subprocess.run([ffmpeg, '-y', '-v', 'error', '-i', video.name, '-vf', ','.join(chain), '-frames:v', '1', '-q:v', '4', out.name],
                                  cwd=str(folder), capture_output=True, timeout=600)
        except (OSError, subprocess.SubprocessError):
            continue
        if done.returncode == 0 and out.is_file() and out.stat().st_size > 0:
            return out
    return None


def make_keyframes(video: Path, take: dict, duration: float, fps: float) -> list[dict]:
    """A JPEG from the middle of each shot, at most 480 px wide."""
    ffmpeg = find_tool('ffmpeg')
    video = Path(video)
    if not ffmpeg or duration <= 0:
        return []
    found = []
    for index, shot in enumerate(take.get('shots') or []):
        if not isinstance(shot, dict) or not isinstance(shot.get('shotId'), str) or not SHOT_ID.fullmatch(shot['shotId']):
            continue
        start, end = number(str(shot.get('start', 0))) or 0.0, number(str(shot.get('end', 0))) or 0.0
        middle = min(max(0.0, (start + max(start, end)) / 2), max(0.0, duration - 1 / max(fps, 1)))
        out = video.parent / f'{video.stem}-keyframe-{index + 1}.jpg'
        try:
            done = subprocess.run([ffmpeg, '-y', '-v', 'error', '-ss', f'{middle:.3f}', '-i', video.name, '-frames:v', '1',
                                   '-vf', 'scale=min(480\\,iw):-2', '-q:v', '3', out.name], cwd=str(video.parent), capture_output=True, timeout=300)
        except (OSError, subprocess.SubprocessError):
            continue
        if done.returncode == 0 and out.is_file() and out.stat().st_size > 0:
            found.append({'shotId': shot['shotId'], 'path': out, 'time': round(middle, 3)})
    return found


def speech_tokens(text: str, by_character: bool) -> list[str]:
    """Text for matching: width and case folded, punctuation and symbols removed; characters or words."""
    folded = unicodedata.normalize('NFKC', text).casefold()
    cleaned = ''.join(' ' if unicodedata.category(ch)[0] in 'PSZC' else ch for ch in folded)
    return [ch for ch in cleaned if not ch.isspace()] if by_character else cleaned.split()


def by_character(language: str) -> bool:
    return language.split('-')[0].lower() in ('zh', 'ja')


def score_lines(expected: list[dict], segments: list[dict], max_run: int = 8) -> list[dict]:
    """For each expected line, the best similarity over contiguous runs of recognized segments (0 to 1) and that run's text."""
    lines = []
    for item in expected:
        language, text = str(item.get('language', '')), str(item.get('text', ''))
        chars = by_character(language)
        target = speech_tokens(text, chars)
        tokens = [speech_tokens(str(s.get('text', '')), chars) for s in segments]
        best, heard = (1.0, '') if not target else (0.0, '')
        for i in range(len(segments)) if target else ():
            run: list[str] = []
            for j in range(i, min(len(segments), i + max_run)):
                run = run + tokens[j]
                score = difflib.SequenceMatcher(None, target, run, autojunk=False).ratio()
                if score > best:
                    best = score
                    heard = ('' if chars else ' ').join(str(s.get('text', '')).strip() for s in segments[i:j + 1])
        lines.append({'sceneId': str(item.get('sceneId', '')), 'position': int(item.get('position') or 0), 'language': language,
                      'expected': text, 'heard': scrub(heard), 'score': round(best, 2)})
    return lines


def line_status(score: float) -> str:
    return 'pass' if score >= 0.6 else 'warning' if score >= 0.2 else 'failure'


_speech: dict[str, Any] = {'checked': False, 'ready': False, 'warned': False, 'problem': ''}


def nvidia_library_path() -> str:
    """LD_LIBRARY_PATH with the CUDA libraries that pip packages bring (nvidia-cudnn-cu12, nvidia-cublas-cu12, ...).
    CTranslate2, which faster-whisper uses, loads cuDNN and cuBLAS by name and does not look in site-packages."""
    folders: list[str] = []
    for root in {Path(p) for p in sys.path if p and Path(p).name in ('site-packages', 'dist-packages')}:
        nvidia = root / 'nvidia'
        if nvidia.is_dir():
            folders += sorted(str(lib) for lib in nvidia.glob('*/lib') if lib.is_dir())
    current = os.environ.get('LD_LIBRARY_PATH', '')
    return os.pathsep.join([*folders, *([current] if current else [])])


def cuda_available() -> bool:
    return query_gpu() is not None


def speech_available() -> bool:
    """faster-whisper can run: it is installed, or it was installed now because this machine has an NVIDIA GPU."""
    if _speech['checked']:
        return _speech['ready']
    _speech['checked'] = True
    ready = all(importlib.util.find_spec(name) for name in ('faster_whisper', 'numpy'))
    if not ready and cuda_available():
        log('installing faster-whisper for the speech check')
        try:
            run_command([sys.executable, '-m', 'pip', 'install', '-q', 'faster-whisper'], timeout=900)
        except WorkerError as error:
            _speech['problem'] = f'faster-whisper could not be installed: {error}'
            log(f'speech is not checked: {error}')
        importlib.invalidate_caches()
        ready = all(importlib.util.find_spec(name) for name in ('faster_whisper', 'numpy'))
    if not ready and not _speech['problem']:
        _speech['problem'] = 'faster-whisper is not installed, and this machine has no NVIDIA GPU to run it on'
    _speech['ready'] = ready
    return ready


def transcribe(path: Path, language: str = '') -> dict | None:
    """Recognized speech of a video: {'language', 'segments': [{start, end, text}]}, or None without speech recognition.
    It runs in a child process (the `speech` mode), so a CUDA library problem cannot take the session down."""
    if not speech_available():
        return None
    try:
        done = subprocess.run([sys.executable, str(Path(__file__).resolve()), 'speech', '--input', str(path), '--language', language],
                              capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=1200,
                              env=dict(os.environ, LD_LIBRARY_PATH=nvidia_library_path()))
    except (OSError, subprocess.SubprocessError) as error:
        done, problem = None, str(error)
    if done is not None:
        for line in reversed(done.stdout.splitlines()):
            if line.startswith(SPEECH_MARK):
                try:
                    result = json.loads(line[len(SPEECH_MARK):])
                except ValueError:
                    break
                if isinstance(result, dict) and isinstance(result.get('segments'), list):
                    return result
        problem = ' | '.join((done.stderr or done.stdout or '').strip().splitlines()[-2:]) or f'exit code {done.returncode}'
    _speech['problem'] = f'speech recognition failed: {scrub(problem)[:300]}'
    if not _speech['warned']:
        _speech['warned'] = True
        log(f'speech recognition failed, so speech is not checked: {problem[:300]}')
    return None


def run_speech(args: argparse.Namespace) -> int:
    """The `speech` mode: decode the audio to 16 kHz mono float32 with ffmpeg and give faster-whisper a numpy array
    (a file path would go through PyAV, whose versions differ); print the segments as one JSON line."""
    try:
        import numpy  # noqa: PLC0415 - optional, imported only here
        from faster_whisper import WhisperModel  # noqa: PLC0415
    except ImportError as error:
        log(f'error: speech recognition needs numpy and faster-whisper ({error})')
        return 2
    ffmpeg = find_tool('ffmpeg')
    if not ffmpeg:
        log('error: ffmpeg is not installed')
        return 2
    raw = subprocess.run([ffmpeg, '-v', 'error', '-i', args.input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'],
                         capture_output=True, check=True, timeout=600).stdout
    audio = numpy.frombuffer(raw, dtype=numpy.float32)
    tag = args.language.lower()
    simplified = tag.startswith('zh') and not any(part in tag for part in ('tw', 'hk', 'mo', 'hant'))
    model = WhisperModel('large-v3-turbo', device='cuda', compute_type='float16')
    segments, info = model.transcribe(audio, beam_size=5, initial_prompt=SIMPLIFIED_PROMPT if simplified else None, condition_on_previous_text=False)
    found = [{'start': round(float(s.start), 2), 'end': round(float(s.end), 2), 'text': s.text.strip()} for s in segments if s.text.strip()]
    print(SPEECH_MARK + json.dumps({'language': info.language, 'segments': found}, ensure_ascii=False), flush=True)
    return 0


def qa_take(path: Path, take: dict, extra: dict | None = None) -> tuple[dict, dict]:
    """Technical QA of one take. Returns the summary for the result (checks, loudness, speech) and the files made:
    {'contactSheet': path or None, 'keyframes': [{shotId, path, time}], 'qa': path of the full qa.json}."""
    path = Path(path)
    fps = float(take.get('fps') or 24)
    frames = int(take.get('frames') or 0)
    planned = frames / fps
    checks: list[dict] = []

    def check(check_id: str, status: str, message: str, value: float | None = None) -> None:
        checks.append({'id': check_id, 'status': status, 'message': scrub(message)[:300], **({'value': value} if value is not None else {})})
    data: dict[str, Any] = {'format': 'sciepo-take-qa', 'version': 1, **({'session': extra} if extra else {}),
                            'take': {key: take.get(key) for key in ('jobId', 'n', 'output', 'mode', 'frames', 'fps', 'width', 'height', 'seed')}}
    try:
        info, problem = ffprobe_info(path), ''
    except WorkerError as error:
        info, problem = None, str(error)
    duration, video, audio = planned, None, None
    if info is None:
        status, why = ('failure', problem) if problem else ('warning', 'not checked: ffprobe is not installed')
        for check_id in ('duration', 'size', 'frame_rate', 'audio'):
            check(check_id, status, why)
    else:
        streams = [s for s in info.get('streams') or [] if isinstance(s, dict)]
        video = next((s for s in streams if s.get('codec_type') == 'video'), None)
        audio = next((s for s in streams if s.get('codec_type') == 'audio'), None)
        data['probe'] = {'format': {k: info.get('format', {}).get(k) for k in ('format_name', 'duration', 'size', 'bit_rate')},
                         'streams': [{k: s.get(k) for k in ('codec_type', 'codec_name', 'width', 'height', 'pix_fmt', 'r_frame_rate', 'avg_frame_rate',
                                                             'duration', 'nb_frames', 'sample_rate', 'channels')} for s in streams]}
        if video is None:
            for check_id in ('duration', 'size', 'frame_rate'):
                check(check_id, 'failure', 'the file has no video stream')
        else:
            rate = parse_rate(video.get('avg_frame_rate')) or parse_rate(video.get('r_frame_rate'))
            measured = number(str(video.get('duration'))) if video.get('duration') is not None else None
            if measured is None and rate and str(video.get('nb_frames', '')).isdigit():
                measured = int(video['nb_frames']) / rate
            if measured is None:
                measured = number(str(info.get('format', {}).get('duration')))
            if measured is None:
                check('duration', 'failure', 'ffprobe reports no duration')
            else:
                duration = measured
                ok = abs(measured - planned) <= 1 / fps + 1e-6
                check('duration', 'pass' if ok else 'failure', f'{measured:.2f} s; planned {planned:.2f} s ({frames} frames at {fps:g} fps)', round(measured, 3))
            size = (video.get('width'), video.get('height'))
            check('size', 'pass' if size == (take.get('width'), take.get('height')) else 'failure',
                  f'{size[0]}×{size[1]}; planned {take.get("width")}×{take.get("height")}')
            if rate is None:
                check('frame_rate', 'failure', 'ffprobe reports no frame rate')
            else:
                check('frame_rate', 'pass' if abs(rate - fps) < 0.01 else 'failure', f'{rate:g} fps; planned {fps:g}', round(rate, 3))
        if audio is None:
            check('audio', 'failure', 'the file has no audio stream')
        else:
            check('audio', 'pass', f"{audio.get('codec_name', '?')}, {audio.get('sample_rate', '?')} Hz, {audio.get('channels', '?')} channels")
    loudness = None
    if audio is None:
        reason = 'not measured: no audio stream' if info is not None else 'not measured'
        check('loudness', 'warning', reason)
        check('silence', 'warning', reason)
    else:
        measured_audio = measure_audio(path, duration)
        if measured_audio is None:
            check('loudness', 'warning', 'not measured: ffmpeg is not installed or could not read the audio')
            check('silence', 'warning', 'not measured: ffmpeg is not installed or could not read the audio')
        else:
            integrated, peak, spread = measured_audio['integrated'], measured_audio['truePeak'], measured_audio['range']
            data['loudness'] = {'integrated': integrated, 'truePeak': peak, 'range': spread}
            data['silences'] = measured_audio['silences']
            if integrated is None:
                check('loudness', 'warning', 'ebur128 reported no integrated loudness')
            else:
                peak_text = f'{peak:.1f} dBTP' if peak is not None else 'none (silent)'
                range_text = f', range {spread:.1f} LU' if spread is not None else ''
                check('loudness', 'pass', f'{integrated:.1f} LUFS integrated, true peak {peak_text}{range_text}', round(integrated, 1))
                if peak is not None:
                    loudness = {'integrated': round(integrated, 1), 'truePeak': round(peak, 1), **({'range': round(spread, 1)} if spread is not None else {})}
            long = [s for s in measured_audio['silences'] if s['duration'] > 2.0]
            if long:
                listed = ', '.join(f"{s['start']:.1f}–{s['end']:.1f} s" for s in long[:8])
                check('silence', 'warning', f'silence longer than 2 s at {listed}', round(max(s['duration'] for s in long), 2))
            else:
                check('silence', 'pass', 'no silence longer than 2 s', 0)
    sheet = make_contact_sheet(path, take, duration) if video is not None else None
    keyframes = make_keyframes(path, take, duration, fps) if video is not None else []
    data['contactSheet'] = sheet.name if sheet else None
    data['keyframes'] = [{'shotId': k['shotId'], 'time': k['time'], 'file': k['path'].name} for k in keyframes]
    speech = None
    expected = [line for line in take.get('expectedLines') or [] if isinstance(line, dict) and str(line.get('text', '')).strip()]
    # A rehearsal take speaks a test tone, so its lines are not listened for.
    if expected and audio is not None and not take.get('rehearsal'):
        languages = {str(line.get('language', '')) for line in expected}
        heard = transcribe(path, languages.pop() if len(languages) == 1 else '')
        if heard:
            segments = [s for s in heard.get('segments') or [] if isinstance(s, dict)]
            lines = score_lines(expected, segments)
            for line in lines:
                said = f'heard "{line["heard"][:120]}"' if line['heard'] else 'not heard'
                check('line', line_status(line['score']), f"scene {line['sceneId']}, line {line['position']}: {said}", line['score'])
            speech = {'language': str(heard.get('language') or ''), 'lines': lines}
            data['speech'] = {**speech, 'segments': [{'start': s.get('start'), 'end': s.get('end'), 'text': scrub(s.get('text', ''))} for s in segments]}
        else:
            # The take has lines to check but no speech recognition ran: say why, so the author does not read silence as a pass.
            check('speech', 'warning', f"the spoken lines were not checked: {_speech['problem'] or 'speech recognition is not available'}")
    data['checks'] = checks
    qa_path = path.with_name(f'{path.stem}-qa.json')
    text = json.dumps(data, ensure_ascii=False, indent=1)
    if len(text.encode('utf-8')) > 480_000 and 'speech' in data:  # Sci-epo takes QA data up to 512 KB
        data['speech']['segments'] = data['speech']['segments'][:200]
        text = json.dumps(data, ensure_ascii=False)
    qa_path.write_text(text, encoding='utf-8')
    summary: dict[str, Any] = {'checks': checks, **({'loudness': loudness} if loudness else {}), **({'speech': speech} if speech else {})}
    return summary, {'contactSheet': sheet, 'keyframes': keyframes, 'qa': qa_path, 'seconds': round(duration, 3)}


# --------------------------------------------------------------------------- render sessions: the worker

class SessionClient(SciEpo):
    """The worker side of Sci-epo's session API. The token goes only to this server, in the Authorization header."""

    GONE = 'Sci-epo no longer accepts this session code: it is wrong or expired, or the session has ended'

    def url(self, *parts: Any, query: dict | None = None) -> str:
        path = '/'.join(urllib.parse.quote(str(part), safe='') for part in parts)
        return f'{self.base}/{path}' + (f'?{urllib.parse.urlencode(query)}' if query else '')

    def request(self, method: str, parts: tuple, payload: Any = None, timeout: float | None = None) -> tuple[int, Any]:
        status, data = http_json(method, self.url(*parts), payload, self.headers, timeout or self.timeout)
        if status == 401:
            raise SessionGone(self.GONE)
        return status, data

    def upload(self, job_id: str, n: int, kind: str, path: Path, shot: str | None = None) -> tuple[int, Any]:
        url = self.url('takes', job_id, n, 'files', kind, query={'shot': shot} if shot else None)
        status, raw = http_upload(url, path, {**self.headers, 'content-type': UPLOAD_TYPES[kind], 'accept': 'application/json'})
        if status == 401:
            raise SessionGone(self.GONE)
        try:
            return status, json.loads(raw.decode('utf-8')) if raw else None
        except ValueError:
            return status, {'error': raw[:200].decode('utf-8', 'replace')}

    def download(self, parts: tuple, dest: Path, limit: int) -> tuple[int, str, int]:
        status, digest, size = http_download(self.url(*parts), dest, self.headers, limit)
        if status == 401:
            raise SessionGone(self.GONE)
        return status, digest, size


class TakeWatch:
    """Heartbeats while one take is in hand. They keep its lease and bring the author's stop, the batch's currency
    and the budget; a stop at once, or a render still running 5 minutes after the budget, interrupts ComfyUI."""

    def __init__(self, worker: SessionWorker, take: dict):
        self.worker, self.take = worker, take
        self.done = threading.Event()
        self.rendering = False
        self.interrupted: str | None = None
        self.thread = threading.Thread(target=self.run, name=f"heartbeat {take['jobId']}", daemon=True)

    def __enter__(self) -> TakeWatch:
        self.thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.done.set()
        self.thread.join(timeout=10)

    def run(self) -> None:
        while not self.done.wait(self.worker.heartbeat_s):
            try:  # a heartbeat that fails must never end the thread
                self.worker.heartbeat(self.take)
            except SessionGone:
                self.worker.gone = True
            except Exception as error:  # noqa: BLE001
                log(f'heartbeat failed: {error}')
            try:
                self.check()
            except Exception as error:  # noqa: BLE001
                log(f'could not interrupt the render: {error}')

    def check(self) -> None:
        worker = self.worker
        reason = 'stopped' if worker.stop_now else 'budget' if worker.past_budget() else 'expired' if worker.gone else None
        if reason and self.rendering and not self.interrupted:
            self.interrupted = reason
            if reason == 'budget':
                worker.request_end('budget', 'the take was still rendering 5 minutes after the budget')
            worker.interrupt()


class SessionWorker:
    """One render session: check the GPU, set up the pinned stack, then claim, render, check and deliver takes."""

    def __init__(self, client: SessionClient, comfy_dir: Path, work_dir: Path, comfy_url: str, skip_setup: bool = False):
        self.client, self.comfy_dir, self.work_dir = client, Path(comfy_dir).expanduser().resolve(), Path(work_dir).expanduser().resolve()
        self.comfy_url, self.skip_setup = comfy_url.rstrip('/'), skip_setup
        self.refs_dir = self.work_dir / 'refs'
        self.upload_window, self.backoff = UPLOAD_WINDOW_S, UPLOAD_BACKOFF_S
        self.lock = threading.Lock()
        self.stage, self.mode, self.session_id = 'connecting', '', ''
        self.heartbeat_s, self.budget_end, self.estimate_takes = 30.0, None, 0
        self.end_after: tuple[str, str] | None = None
        self.stop_now = self.gone = False
        self.rendered = self.failed = 0
        self.undelivered: list[dict] = []
        self.current: dict | None = None
        self.watch: TakeWatch | None = None
        self.cancel: threading.Event | None = None
        self.backends: dict[str, ComfyUIBackend] = {}
        self.comfy_process: subprocess.Popen | None = None
        self.comfy_log: Any = None
        self.started = time.monotonic()

    # ---------------------------------------------------------------- signals from Sci-epo

    def request_end(self, reason: str, message: str) -> None:
        with self.lock:
            if self.end_after is None:
                self.end_after = (reason, message)
                log(f'the session will end ({reason}): {message}')

    def note_stop(self, when: Any) -> None:
        if when == 'now':
            if not self.stop_now:
                self.stop_now = True
                self.request_end('stopped', 'the author stopped the session at once')
        elif when == 'after_take':
            self.request_end('stopped', 'the author stopped the session after the current take')

    def past_budget(self) -> bool:
        return self.budget_end is not None and time.time() > self.budget_end + BUDGET_GRACE_S

    def check_stop(self) -> None:
        if self.end_after:
            raise SessionEnded(*self.end_after)

    def event(self, stage: str, message: str | None = None, data: dict | None = None) -> None:
        """Report a stage. Events are best effort: a network problem is logged, not raised."""
        if stage != 'error':
            self.stage = stage
        log(f'{stage}' + (f': {message}' if message else ''))
        payload: dict[str, Any] = {'stage': stage}
        if message:
            payload['message'] = scrub(message)[:500]
        values = {key: scrub(value)[:200] if isinstance(value, str) else value for key, value in (data or {}).items()
                  if isinstance(value, (str, bool)) or (isinstance(value, (int, float)) and math.isfinite(value))}
        if values:
            payload['data'] = values
        try:
            status, answer = self.client.request('POST', ('session', 'events'), payload)
        except NetworkError as error:
            log(f'could not report {stage}: {error}')
            return
        if status == 200 and isinstance(answer, dict):
            self.note_stop(answer.get('stop'))
        else:
            log(f'Sci-epo did not take the {stage} event (HTTP {status}): {error_text(answer)}')

    def heartbeat(self, take: dict) -> None:
        status, answer = self.client.request('POST', ('takes', take['jobId'], take['n'], 'heartbeat'), {})
        if status != 200 or not isinstance(answer, dict):
            log(f'heartbeat answered HTTP {status}: {error_text(answer)}')
            return
        self.note_stop(answer.get('stop'))
        if answer.get('current') is False:
            self.request_end('not_current', 'a batch of the session is no longer the current production version')
        self.budget_end = parse_time(answer.get('budgetEndsAt')) or self.budget_end

    def interrupt(self) -> None:
        """Stop the render in hand: ComfyUI's /interrupt, and stop waiting for it."""
        if self.cancel is not None:
            self.cancel.set()
        if self.mode != 'pull':
            return
        try:
            status, _ = http('POST', f'{self.comfy_url}/interrupt', b'{}', {'content-type': 'application/json'}, timeout=15)
            log(f'asked ComfyUI to interrupt the render (HTTP {status})')
        except NetworkError as error:
            log(f'could not reach ComfyUI to interrupt the render: {error}')

    def with_retry(self, what: str, attempt: Callable[[], tuple[int, Any]], until: float | None = None, tries: int | None = None) -> tuple[int, Any]:
        """Call attempt() again after network errors and 408, 425, 429 and 5xx answers, with exponential back-off,
        until it returns another status or the time or tries run out; then the last answer is returned (or raised)."""
        delay, count = self.backoff, 0
        while True:
            count += 1
            try:
                status, data = attempt()
                if status not in RETRYABLE:
                    return status, data
                problem, failure = f'HTTP {status}: {error_text(data)}', None
            except NetworkError as error:
                status, data, problem, failure = 0, None, str(error), error
            if (until is not None and time.monotonic() + delay > until) or (tries is not None and count >= tries):
                if failure is not None:
                    raise failure
                return status, data
            log(f'{what} failed ({problem}); trying again in {delay:.1f} s')
            time.sleep(delay)
            delay = min(delay * 2, 60.0)

    # ---------------------------------------------------------------- the session

    def run(self) -> int:
        """The whole session; returns 0 after a normal end (queue empty, stopped, budget, not current), 3 otherwise."""
        self.started = time.monotonic()
        try:
            reason, message = self.session()
        except SessionEnded as end:
            reason, message = end.reason, end.message
        except SessionGone as error:
            self.gone = True
            reason, message = 'expired', str(error)
            log(f'error: {error}')
        except KeyboardInterrupt:
            reason, message = 'stopped', 'the worker was stopped on the runtime'
            self.abort_take()
        except Exception as error:  # noqa: BLE001 - every failure ends the session with a reason
            reason = 'error'
            message = scrub(str(error) if isinstance(error, WorkerError) else f'unexpected {type(error).__name__}: {error}')
            self.abort_take()
            try:
                if self.gone:
                    raise SessionGone(SessionClient.GONE)
                self.event('error', message, {'stage': self.stage})  # also prints it
            except SessionGone:
                self.gone = True
                log(f'error: {message}')
        self.finish(reason, message)
        return 0 if reason in NORMAL_ENDS else 3

    def session(self) -> tuple[str, str]:
        doc = self.document()
        settings = doc['session']
        self.session_id, self.mode = str(settings.get('id', '')), settings.get('mode')
        if self.mode not in ('pull', 'rehearsal'):
            raise WorkerError(f'this worker does not know the session mode {str(self.mode)[:40]!r}')
        self.heartbeat_s = min(300.0, max(0.1, float(settings.get('heartbeatSeconds') or 30)))
        self.budget_end = parse_time(settings.get('budgetEndsAt'))
        self.estimate_takes = int((doc.get('estimate') or {}).get('takes') or 0)
        self.event('connected', f'worker {program_sha256()[:12]}, Python {platform.python_version()}',
                   {'workerSha256': program_sha256(), 'python': platform.python_version()})
        log(f"session {self.session_id}: {self.mode}, budget {settings.get('budgetMinutes', '?')} min until {clock(self.budget_end)}, "
            f'about {self.estimate_takes} takes')
        modes = [m for m in doc.get('modes') or [] if isinstance(m, str)]
        if self.mode == 'rehearsal':
            if not find_tool('ffmpeg'):
                raise WorkerError('ffmpeg is not installed; a rehearsal makes its placeholder takes with ffmpeg')
            self.event('ready', 'rehearsal: placeholder takes made with ffmpeg; no GPU and no models')
        else:
            stacks = [s for s in doc.get('stacks') or [] if isinstance(s, dict)]
            if not modes:
                return 'queue_empty', 'no takes were waiting when the session started'
            if not stacks:
                raise WorkerError('the session document names no stack profile')
            self.check_gpu(stacks, modes, settings.get('allowUntestedGpu') is True)
            # Before any install: a mode without a workflow in the stack profile could only fail its takes.
            missing = [m for m in modes if not any(isinstance((s.get('workflowGraphs') or {}).get(m), dict) for s in stacks)]
            if missing:
                raise WorkerError(f"the stack profile of this session has no {' or '.join(missing)} workflow, "
                                  f"but takes of the session need {'it' if len(missing) == 1 else 'them'}")
            self.check_stop()
            if self.skip_setup:
                self.wait_for_comfyui(30.0)
            else:
                self.setup(stacks, modes)
            self.check_nodes(stacks, modes)
            for stack in stacks:
                graphs = {m: g for m, g in (stack.get('workflowGraphs') or {}).items() if isinstance(g, dict)}
                if graphs:
                    self.backends[str(stack.get('id', ''))] = ComfyUIBackend(self.comfy_url, graphs, self.refs_dir, timeout_s=TAKE_TIMEOUT_S, poll_s=COMFY_POLL_S)
            commit = self.comfy_commit()
            self.event('ready', f'ComfyUI {commit[:12]} on {self.comfy_url}' if commit else f'ComfyUI on {self.comfy_url}',
                       {'comfyCommit': commit} if commit else None)
        self.fetch_references(doc.get('references') or [])
        self.check_stop()
        return self.loop()

    def document(self) -> dict:
        status, doc = self.with_retry('reading the session', lambda: self.client.request('GET', ('session',)), tries=4)
        if status != 200 or not isinstance(doc, dict):
            raise WorkerError(f'Sci-epo answered HTTP {status} for the session: {error_text(doc)}')
        if doc.get('format') != SESSION_FORMAT or doc.get('version') != 1 or not isinstance(doc.get('session'), dict):
            raise WorkerError('the server did not send a Sci-epo session document (format sciepo-session, version 1)')
        return doc

    def finish(self, reason: str, message: str) -> None:
        minutes = (time.monotonic() - self.started) / 60
        summary = f'{reason}: {self.rendered} rendered, {self.failed} failed, {len(self.undelivered)} undelivered, {minutes:.1f} min'
        summary += f'. {message}' if message else ''
        try:
            if not self.gone:
                self.event('finishing', summary, {'reason': reason})
                body = {'reason': reason if reason in SESSION_ENDS else 'error', 'summary': {'message': scrub(summary)[:500]},
                        'undelivered': self.undelivered}
                status, answer = self.with_retry('ending the session', lambda: self.client.request('POST', ('session', 'end'), body), tries=4)
                if status != 200:
                    log(f'Sci-epo did not take the end of the session (HTTP {status}): {error_text(answer)}')
        except SessionGone:
            self.gone = True
        except NetworkError as error:
            log(f'could not report the end of the session: {error}')
        finally:
            self.stop_comfyui()
        log(f'session ended: {summary}')

    def abort_take(self) -> None:
        """The session ends while a take is in hand: nothing of it reached Sci-epo, which queues it again."""
        if self.current is not None:
            self.undelivered.append(self.current)
            self.current = None
        if self.watch is not None and self.watch.rendering:
            try:
                self.interrupt()
            except Exception:  # noqa: BLE001
                pass

    # ---------------------------------------------------------------- GPU, stack and references

    def check_gpu(self, stacks: list[dict], modes: list[str], allow_untested: bool) -> None:
        found = query_gpu()
        name, vram = found if found else ('unknown', 0.0)
        missing = untested_gpu(stacks, modes, name, vram) if found else [f"{s.get('id', '?')} {m}" for s in stacks for m in modes]
        message = f'{name}, {vram:.1f} GB' if found else 'no NVIDIA GPU found (nvidia-smi is missing or failed)'
        if missing and allow_untested:
            message += f"; not tested with {', '.join(missing)}, allowed for this session"
        self.event('gpu', message, {'gpu': name, **({'vramGb': vram} if found else {})})
        if missing and not allow_untested:
            tested = '; '.join(f"{g.get('name')} with {g.get('minVramGb')} GB for {', '.join(g.get('modes') or [])}"
                               for s in stacks for g in s.get('testedGpus') or [] if isinstance(g, dict)) or 'none'
            raise WorkerError(f"{'the GPU ' + name if found else 'this runtime'} ({vram:.1f} GB) is not tested with {', '.join(missing)}. "
                              f'Tested: {tested}. Choose a tested runtime, or allow untested GPUs for the session.')

    def setup(self, stacks: list[dict], modes: list[str]) -> None:
        pins = {(str((s.get('comfyui') or {}).get('repo', '')), str((s.get('comfyui') or {}).get('commit', ''))) for s in stacks}
        if len(pins) != 1:
            raise WorkerError('the stacks of this session pin different ComfyUI commits; render them in separate sessions')
        repo, commit = pins.pop()
        if not COMMIT.fullmatch(commit) or not repo.startswith('https://'):
            raise WorkerError('the stack profile has no valid ComfyUI repository and commit')
        self.event('installing', f'ComfyUI {commit[:12]} into {self.comfy_dir}')
        self.install_comfyui(repo, commit)
        self.check_stop()
        run_command([sys.executable, '-m', 'pip', 'install', '-q', '-r', 'requirements.txt'], cwd=self.comfy_dir)
        run_command([sys.executable, '-m', 'pip', 'install', '-q', 'huggingface_hub[hf_transfer]'])
        self.check_stop()
        self.download_models(model_files(stacks, modes))
        self.check_stop()
        self.event('starting_comfyui', f'ComfyUI on {self.comfy_url}')
        self.start_comfyui()

    def install_comfyui(self, repo: str, commit: str) -> None:
        git = shutil.which('git')
        if not git:
            raise WorkerError('git is not installed; it is needed to install ComfyUI')
        target = self.comfy_dir
        if not (target / '.git').exists():
            if target.exists() and any(target.iterdir()):
                raise WorkerError(f'{target} is not empty and not a git checkout; pass an empty --comfy-dir, or --skip-setup with a running ComfyUI')
            target.parent.mkdir(parents=True, exist_ok=True)
            run_command([git, 'clone', '--depth', '1', repo, target], timeout=900)
        if self.comfy_commit() != commit:
            run_command([git, '-C', target, 'fetch', '--depth', '1', 'origin', commit], timeout=900)
            run_command([git, '-C', target, 'checkout', '--quiet', commit], timeout=300)
        if self.comfy_commit() != commit:
            raise WorkerError(f'ComfyUI in {target} is not at the pinned commit {commit[:12]}')

    def comfy_commit(self) -> str | None:
        git = shutil.which('git')
        if not git or not (self.comfy_dir / '.git').exists():
            return None
        try:
            head = subprocess.run([git, '-C', str(self.comfy_dir), 'rev-parse', 'HEAD'], capture_output=True, text=True, timeout=30).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return None
        return head if COMMIT.fullmatch(head) else None

    def model_bytes(self, files: list[dict]) -> int:
        """Planned bytes: the stack's `gb` where it gives one; Hugging Face's file sizes for the others, when it answers."""
        total, unknown = 0, []
        for item in files:
            gb = item.get('gb')
            if isinstance(gb, (int, float)) and gb > 0:
                total += int(gb * 1e9)
            else:
                unknown.append(item)
        if unknown:
            try:
                from huggingface_hub import HfApi  # noqa: PLC0415 - installed by the setup
                api = HfApi()
                for repo in sorted({item['repo'] for item in unknown}):
                    for info in api.get_paths_info(repo, [item['path'] for item in unknown if item['repo'] == repo]):
                        total += int(getattr(info, 'size', 0) or 0)
            except Exception as error:  # noqa: BLE001 - only the progress total is less exact
                log(f'could not read the size of {len(unknown)} model files: {error}')
        return total

    def download_models(self, files: list[dict]) -> None:
        models = self.comfy_dir / 'models'
        models.mkdir(parents=True, exist_ok=True)
        os.environ['HF_XET_HIGH_PERFORMANCE'] = '1'  # read when huggingface_hub is imported
        importlib.invalidate_caches()
        try:
            import huggingface_hub  # noqa: PLC0415 - installed a moment ago
        except ImportError as error:
            raise WorkerError(f'huggingface_hub is not installed: {error}') from error
        total = self.model_bytes(files)
        baseline = dir_bytes(models)
        present = sum((models / f['dest']).stat().st_size for f in files if (models / f['dest']).is_file())
        self.event('downloading', f'{len(files)} model files, {format_bytes(total)}', {'bytesDone': present, 'bytesTotal': total, 'files': len(files)})
        failure: list[BaseException] = []
        finished = threading.Event()

        def work() -> None:
            try:
                fetch_models(huggingface_hub, files, models)
            except BaseException as error:  # noqa: BLE001 - reported by the main thread
                failure.append(error)
            finally:
                finished.set()
        threading.Thread(target=work, name='model download', daemon=True).start()
        while not finished.wait(DOWNLOAD_EVENT_S):
            done = present + max(0, dir_bytes(models) - baseline)
            self.event('downloading', f'{format_bytes(done)} of {format_bytes(total)}', {'bytesDone': done, 'bytesTotal': total})
            self.check_stop()
        if failure:
            raise WorkerError(f'model download failed: {failure[0]}')
        done = sum((models / f['dest']).stat().st_size for f in files)
        self.event('downloading', f'{len(files)} model files ready, {format_bytes(done)}', {'bytesDone': done, 'bytesTotal': done})

    def comfy_answers(self) -> bool:
        try:
            return http('GET', f'{self.comfy_url}/system_stats', timeout=5)[0] == 200
        except NetworkError:
            return False

    def wait_for_comfyui(self, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while not self.comfy_answers():
            if time.monotonic() > deadline:
                raise WorkerError(f'ComfyUI does not answer at {self.comfy_url}; with --skip-setup it must already run')
            time.sleep(1)

    def start_comfyui(self) -> None:
        if self.comfy_answers():
            log(f'ComfyUI already answers at {self.comfy_url}; using it')
            return
        port = urllib.parse.urlsplit(self.comfy_url).port or 8188
        self.work_dir.mkdir(parents=True, exist_ok=True)
        log_path = self.work_dir / 'comfyui.log'
        self.comfy_log = open(log_path, 'ab')  # noqa: SIM115 - closed in stop_comfyui
        self.comfy_process = subprocess.Popen([sys.executable, 'main.py', '--listen', '127.0.0.1', '--port', str(port), '--disable-auto-launch'],
                                              cwd=str(self.comfy_dir), stdout=self.comfy_log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + COMFY_START_S
        while time.monotonic() < deadline:
            code = self.comfy_process.poll()
            if code is not None:
                tail = ' | '.join(log_path.read_text(encoding='utf-8', errors='replace').strip().splitlines()[-3:])
                raise WorkerError(f'ComfyUI exited with code {code} while starting: {tail[:300]}')
            if self.comfy_answers():
                log(f'ComfyUI answers at {self.comfy_url}; its log is {log_path}')
                return
            time.sleep(2)
        raise WorkerError(f'ComfyUI did not answer within {COMFY_START_S / 60:.0f} minutes; see {log_path}')

    def stop_comfyui(self) -> None:
        if self.comfy_process is not None and self.comfy_process.poll() is None:
            self.comfy_process.terminate()
            try:
                self.comfy_process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.comfy_process.kill()
        if self.comfy_log is not None:
            self.comfy_log.close()
            self.comfy_log = None

    def check_nodes(self, stacks: list[dict], modes: list[str]) -> None:
        status, info = http_json('GET', f'{self.comfy_url}/object_info', timeout=180)
        if status != 200 or not isinstance(info, dict):
            raise WorkerError(f'ComfyUI did not list its node classes (HTTP {status})')
        needed = sorted({c for s in stacks for m in modes for c in (s.get('requiredNodes') or {}).get(m) or [] if isinstance(c, str)})
        missing = [c for c in needed if c not in info]
        if missing:
            raise WorkerError(f"ComfyUI lacks node classes the stack needs: {', '.join(missing)}")
        log(f'ComfyUI has the {len(needed)} node classes the stack needs')

    def fetch_references(self, refs: list) -> None:
        if not refs:
            return
        self.refs_dir.mkdir(parents=True, exist_ok=True)
        for ref in refs:
            name, sha = (ref.get('name'), ref.get('sha256')) if isinstance(ref, dict) else (None, None)
            if not (isinstance(name, str) and SAFE_NAME.fullmatch(name) and isinstance(sha, str) and SHA256_HEX.fullmatch(sha)):
                raise WorkerError(f'Sci-epo sent an invalid reference entry: {str(ref)[:80]}')
            dest = self.refs_dir / name
            if dest.is_file() and file_sha256(dest) == sha:
                continue
            size = ref.get('bytes')
            limit = size if isinstance(size, int) and size > 0 else 64 * MB
            status, digest, got = self.download_reference(sha, dest, limit)
            if status != 200:
                raise WorkerError(f'cannot download the reference {name} (HTTP {status})')
            if digest != sha:
                dest.unlink(missing_ok=True)
                raise WorkerError(f'the reference {name} does not match its SHA-256; it was not used')
            log(f'reference {name}: {format_bytes(got)}, SHA-256 checked')
        log(f'{len(refs)} reference files are in {self.refs_dir}')

    def download_reference(self, sha: str, dest: Path, limit: int) -> tuple[int, str, int]:
        found: dict[str, Any] = {}

        def attempt() -> tuple[int, Any]:
            status, digest, size = self.client.download(('references', sha), dest, limit)
            found.update(digest=digest, size=size)
            return status, None
        status, _ = self.with_retry(f'downloading the reference {dest.name}', attempt, tries=4)
        return status, found.get('digest', ''), found.get('size', 0)

    # ---------------------------------------------------------------- takes

    def loop(self) -> tuple[str, str]:
        index, failures = 0, 0
        while True:
            if self.end_after:
                return self.end_after
            status, answer = self.with_retry('claiming a take', lambda: self.client.request('POST', ('session', 'claim'), {}),
                                             until=time.monotonic() + CLAIM_RETRY_S)
            if status != 200 or not isinstance(answer, dict):
                raise WorkerError(f'cannot claim the next take (HTTP {status}): {error_text(answer)}')
            if isinstance(answer.get('take'), dict):
                index += 1
                outcome = self.process_take(answer['take'], index)
                if outcome == 'interrupted':
                    if self.gone:
                        raise SessionGone(SessionClient.GONE)
                    return self.end_after or ('stopped', 'the render was interrupted')
                failures = 0 if outcome == 'rendered' else failures + 1
                if failures >= 2:
                    return 'failures', 'two takes in a row failed or could not be delivered'
            elif isinstance(answer.get('wait'), (int, float)):
                seconds = min(300.0, max(0.05, float(answer['wait'])))
                log(f'no take is waiting yet; asking again in {seconds:.0f} s')
                time.sleep(seconds)
            elif isinstance(answer.get('end'), str):
                reason = answer['end'] if answer['end'] in SESSION_ENDS else 'error'
                return reason, {'queue_empty': 'no take is left to render', 'budget': 'the next take would end after the budget',
                                'stopped': 'the author stopped the session', 'not_current': 'a batch is no longer the current production version'}.get(reason, f'Sci-epo ended the session ({reason})')
            else:
                raise WorkerError(f'Sci-epo answered the claim with something unexpected: {error_text(answer)}')

    def job_for(self, take: dict) -> dict:
        """The backend job of a take: the take's prompt and settings, with output <stem>-t<n>.mp4."""
        output = take.get('output')
        if not isinstance(output, str) or not SAFE_NAME.fullmatch(output):
            raise WorkerError('the take has no valid output name')
        job = {'id': f"{take['jobId']}-t{take['n']}", 'mode': take.get('mode'), 'prompt': take.get('prompt'), 'frames': take.get('frames'),
               'width': take.get('width'), 'height': take.get('height'), 'seed': take.get('seed'), 'images': list(take.get('images') or []),
               'audio': list(take.get('audio') or []), 'output': f"{Path(output).stem}-t{take['n']}.mp4"}
        if take.get('steps') is not None:
            if not isinstance(take['steps'], int) or isinstance(take['steps'], bool) or not 1 <= take['steps'] <= 500:
                raise WorkerError('the take has no valid step count')
            job['steps'], job['turbo'] = take['steps'], take.get('turbo') is True
        fps = take.get('fps', 24)
        if not isinstance(fps, (int, float)) or isinstance(fps, bool) or not 1 <= fps <= 120:
            raise WorkerError('the take has no valid frame rate')
        return validate_job(job)

    def process_take(self, take: dict, index: int) -> str:
        """Render, check and deliver one take: 'rendered', 'failed', 'undelivered' or 'interrupted'."""
        job_id, n = take.get('jobId'), take.get('n')
        if not (isinstance(job_id, str) and ID_TEXT.fullmatch(job_id) and isinstance(n, int) and not isinstance(n, bool) and n >= 1):
            raise WorkerError('Sci-epo sent a take without a valid job id and take number')
        ref = {'jobId': job_id, 'n': n}
        self.current = ref
        label = f"{take.get('output', job_id)} take {n}"
        try:
            job = self.job_for(take)
        except WorkerError as error:
            self.failed += 1
            return self.report_failure(take, label, f'invalid take: {error}', 0.0)
        folder = self.work_dir / 'takes' / f"{Path(job['output']).stem}-{job_id[:8]}"
        with TakeWatch(self, take) as watch:
            self.watch = watch
            try:
                outcome = self.run_take(take, job, watch, folder, label, index)
            finally:
                self.watch = None
        if outcome == 'rendered':
            self.rendered += 1
        elif outcome != 'failed':  # interrupted or undelivered: nothing usable reached Sci-epo, which queues it again
            if outcome == 'interrupted':
                log(f'{label} was not finished; Sci-epo will queue it again with the same seed')
            self.undelivered.append(ref)
        self.current = None
        return outcome

    def run_take(self, take: dict, job: dict, watch: TakeWatch, folder: Path, label: str, index: int) -> str:
        """The steps of one take while its heartbeats run: render, check, deliver."""
        job_id, n = take['jobId'], take['n']
        count = max(self.estimate_takes, index)
        details = f"{take.get('mode')}, {take.get('frames')} frames, {take.get('width')}x{take.get('height')}" + (f", {take['steps']} steps" if take.get('steps') else '')
        self.event('rendering', f'{label} ({index} of about {count}; {details})',
                   {'jobId': job_id, 'n': n, 'output': str(take.get('output')), 'index': index, 'count': count})
        if self.stop_now or self.gone:
            return 'interrupted'
        started = time.monotonic()
        watch.rendering = True
        try:
            video = self.render(take, job, folder)
        except Exception as error:  # noqa: BLE001 - a failed render is reported, not raised
            watch.rendering = False
            if watch.interrupted or self.gone:
                return 'interrupted'
            self.failed += 1
            message = str(error) if isinstance(error, WorkerError) else f'unexpected {type(error).__name__}: {error}'
            return self.report_failure(take, label, message, time.monotonic() - started)
        finally:
            watch.rendering = False
        render_seconds = time.monotonic() - started
        log(f'{label} rendered in {render_seconds:.0f} s')
        self.event('checking', label, {'jobId': job_id, 'n': n})
        note = f'sciepo session {self.session_id} job {job_id} take {n}'
        if self.mode == 'pull':
            video = tag_video(video, note)
        try:
            summary, files = qa_take(video, take, extra={'id': self.session_id, 'jobId': job_id, 'n': n})
        except Exception as error:  # noqa: BLE001 - QA problems never cost a take
            log(f'QA of {label} failed: {error}')
            self.event('error', f'QA of {label} failed: {error}', {'stage': 'checking', 'jobId': job_id, 'n': n})
            summary, files = {'checks': []}, {'contactSheet': None, 'keyframes': [], 'qa': None}
        for image in [files.get('contactSheet'), *[k['path'] for k in files.get('keyframes') or []]]:
            if image:
                mark_jpeg(image, f'{note} {Path(image).stem}')
        return 'rendered' if self.deliver(take, label, video, summary, files, render_seconds) else 'undelivered'

    def render(self, take: dict, job: dict, folder: Path) -> Path:
        folder.mkdir(parents=True, exist_ok=True)
        if self.mode == 'rehearsal':
            return render_rehearsal(take, folder / job['output'], note=f"sciepo session {self.session_id} job {take['jobId']} take {take['n']}")
        stack = take.get('stack') if isinstance(take.get('stack'), dict) else {}
        backend = self.backends.get(str(stack.get('id', ''))) or (next(iter(self.backends.values())) if len(self.backends) == 1 else None)
        if backend is None:
            raise WorkerError(f"the session document has no stack {str(stack.get('id', ''))[:40]!r}")
        if job['mode'] not in backend.workflows:
            raise WorkerError(f"the stack has no {job['mode']} workflow")
        self.cancel = backend.cancel = threading.Event()
        try:
            entry = backend.render(job, folder)
        finally:
            backend.cancel = None
        return folder / entry['file']

    def report_failure(self, take: dict, label: str, message: str, seconds: float) -> str:
        message = scrub(message)
        log(f'{label} failed: {message}')
        self.event('error', f'{label}: {message}', {'stage': 'rendering', 'jobId': take['jobId'], 'n': take['n']})
        body = {'status': 'failed', 'error': message[:500], 'timing': {'renderSeconds': round(seconds, 1)}}
        deadline = time.monotonic() + self.upload_window
        try:
            status, answer = self.with_retry(f'reporting {label}', lambda: self.client.request('POST', ('takes', take['jobId'], take['n'], 'result'), body), until=deadline)
        except NetworkError as error:
            status, answer = 0, str(error)
        if status != 200:
            log(f'Sci-epo did not take the failure of {label} (HTTP {status}): {error_text(answer)}')
            self.undelivered.append({'jobId': take['jobId'], 'n': take['n']})
        self.current = None
        return 'failed'

    def upload(self, take: dict, kind: str, path: Path, until: float, shot: str | None = None) -> str:
        """Upload one file of a take and return its asset id; raises Undelivered."""
        label = kind + (f' {shot}' if shot else '')
        try:
            status, answer = self.with_retry(f'uploading the {label}', lambda: self.client.upload(take['jobId'], take['n'], kind, path, shot), until=until)
        except NetworkError as error:
            raise Undelivered(f'the {label} did not upload: {error}') from error
        if status != 200 or not isinstance(answer, dict) or not isinstance(answer.get('assetId'), str):
            raise Undelivered(f'Sci-epo did not take the {label} (HTTP {status}): {error_text(answer)}')
        log(f'uploaded the {label}: {format_bytes(Path(path).stat().st_size)}')
        return answer['assetId']

    def deliver(self, take: dict, label: str, video: Path, summary: dict, files: dict, render_seconds: float) -> bool:
        """Upload the video and the QA files and post the result, retrying for at most the upload window."""
        deadline = time.monotonic() + self.upload_window
        soft = deadline - min(60.0, self.upload_window / 4)  # QA files leave time for the result
        extras = [p for p in [files.get('contactSheet'), *[k['path'] for k in files.get('keyframes') or []], files.get('qa')] if p]
        total = Path(video).stat().st_size + sum(Path(p).stat().st_size for p in extras)
        self.event('uploading', f'{label}: {format_bytes(total)}', {'jobId': take['jobId'], 'n': take['n'], 'bytes': total})
        try:
            video_asset = self.upload(take, 'video', video, deadline)
            optional: dict[str, Any] = {'keyframes': []}
            for kind, key, path, shot in ([('contact-sheet', 'contactSheet', files['contactSheet'], None)] if files.get('contactSheet') else []) + \
                    [('keyframe', None, k['path'], k['shotId']) for k in files.get('keyframes') or []] + \
                    ([('qa', 'qa', files['qa'], None)] if files.get('qa') else []):
                if time.monotonic() > soft:
                    log(f'no time left in the upload window for the {kind}')
                    continue
                try:
                    asset = self.upload(take, kind, path, soft, shot)
                except Undelivered as error:
                    log(str(error))
                    continue
                if key:
                    optional[key] = asset
                else:
                    optional['keyframes'].append({'shotId': shot, 'assetId': asset})
            body = {'status': 'rendered', 'files': {'video': video_asset, **optional}, 'qa': summary,
                    'seconds': round(float(files.get('seconds') or take['frames'] / float(take.get('fps') or 24)), 2),
                    'timing': {'renderSeconds': round(render_seconds, 1)}}
            try:
                status, answer = self.with_retry(f'reporting {label}', lambda: self.client.request('POST', ('takes', take['jobId'], take['n'], 'result'), body), until=deadline)
            except NetworkError as error:
                raise Undelivered(f'the result did not reach Sci-epo: {error}') from error
            if status != 200:
                raise Undelivered(f'Sci-epo did not take the result (HTTP {status}): {error_text(answer)}')
        except Undelivered as error:
            log(f'{label} was not delivered: {error}')
            self.event('error', f'{label} was not delivered: {error}', {'stage': 'uploading', 'jobId': take['jobId'], 'n': take['n']})
            return False
        log(f"{label} delivered: video, {'contact sheet, ' if optional.get('contactSheet') else ''}{len(optional['keyframes'])} keyframes"
            f"{', qa.json' if optional.get('qa') else ''}")
        return True


def fetch_models(hub: Any, files: list[dict], models: Path) -> None:
    """Download model files into ComfyUI's models folder: snapshot_download per repository for files in place,
    hf_hub_download and a move for files with a target name. Files already there are not downloaded again."""
    by_repo: dict[str, list[str]] = {}
    for item in files:
        if not item['target']:
            by_repo.setdefault(item['repo'], []).append(item['path'])
    for repo, paths in by_repo.items():
        hub.snapshot_download(repo_id=repo, allow_patterns=paths, local_dir=str(models), max_workers=4)
    for item in files:
        dest = models / item['target'] if item['target'] else None
        if dest is None or (dest.is_file() and dest.stat().st_size > 0):
            continue
        got = Path(hub.hf_hub_download(repo_id=item['repo'], filename=item['path'], local_dir=str(models / '.sciepo-download')))
        dest.parent.mkdir(parents=True, exist_ok=True)
        os.replace(got, dest)
    missing = [item['dest'] for item in files if not (models / item['dest']).is_file()]
    if missing:
        raise WorkerError(f"not downloaded: {', '.join(missing)}")


def run_session(args: argparse.Namespace) -> int:
    """The `session` mode. The code is read from $SCIEPO_SESSION and never printed."""
    try:
        server, token = parse_session_code(os.environ.get('SCIEPO_SESSION', ''))
    except WorkerError as error:
        log(f'error: {error}')
        return 3
    worker = SessionWorker(SessionClient(server, token), comfy_dir=Path(args.comfy_dir).expanduser(), work_dir=Path(args.work_dir).expanduser(),
                           comfy_url=args.comfy_url, skip_setup=args.skip_setup)
    log(f'Sci-epo session at {server}')
    previous = None
    if hasattr(signal, 'SIGTERM') and threading.current_thread() is threading.main_thread():
        def stopped(signum: int, frame: Any) -> None:  # the notebook ends the worker with SIGTERM
            raise KeyboardInterrupt
        previous = signal.signal(signal.SIGTERM, stopped)
    try:
        return worker.run()
    finally:
        if previous is not None:
            signal.signal(signal.SIGTERM, previous)


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

    colab = Path('/content').is_dir()
    session = modes.add_parser('session', help='run a Sci-epo render session; the session code is read from $SCIEPO_SESSION')
    session.add_argument('--comfy-dir', default=str(Path('/content/ComfyUI') if colab else Path.home() / 'sciepo-comfyui'),
                         help='where ComfyUI is installed (default /content/ComfyUI on Colab, else ~/sciepo-comfyui)')
    session.add_argument('--work-dir', default=str(Path('/content/sciepo') if colab else Path.home() / 'sciepo-work'),
                         help='references, takes, QA files and the ComfyUI log (default /content/sciepo on Colab, else ~/sciepo-work)')
    session.add_argument('--comfy-url', default='http://127.0.0.1:8188')
    session.add_argument('--skip-setup', action='store_true', help='use a ComfyUI that already runs with the stack\'s models; install and download nothing')

    speech = modes.add_parser('speech', help='transcribe one video with faster-whisper on CUDA and print the segments as JSON')
    speech.add_argument('--input', required=True)
    speech.add_argument('--language', default='', help='language of the expected lines, such as en or zh-CN (a hint only)')
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.mode == 'session':
        return run_session(args)
    try:
        if args.mode == 'speech':
            return run_speech(args)
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
