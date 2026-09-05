import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import io
import json
import sqlite3
import tempfile

spec = importlib.util.spec_from_file_location('capture', Path(__file__).parents[1] / 'hooks/codex/capture.py')
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)
ID = '01a0723e-0108-75c3-a64c-49a6ce6ed613'


class CodexHookTests(unittest.TestCase):
    def payload(self, **over):
        return dict(session_id=ID, cwd='/tmp/path with "quotes"', hook_event_name='SessionStart', source='startup', **over)

    def test_metadata_only(self):
        p = self.payload(prompt='secret', transcript_path='/private/transcript')
        body = capture.capture_payload(p, {}, 'vps8-core')
        self.assertEqual(body, dict(platform='codex', external_session_id=ID, host='vps8-core',
                                   project_path=p['cwd'], event='start'))

    def test_lifecycle_filter(self):
        for source, expected in [('startup', 'start'), ('resume', 'start'), ('compact', None)]:
            p = {**self.payload(), 'source': source}
            result = capture.capture_payload(p, {}, 'vps8-core')
            self.assertEqual(result['event'] if result else None, expected)
        p = {**self.payload(), 'hook_event_name': 'SessionEnd'}
        self.assertEqual(capture.capture_payload(p, {}, 'vps8-core')['event'], 'end')
        p['hook_event_name'] = 'SubagentStop'
        self.assertIsNone(capture.capture_payload(p, {}, 'vps8-core'))

    def test_herdr_metadata_requires_pane_environment(self):
        env = dict(HERDR_ENV='1', HERDR_SOCKET_PATH='/tmp/h.sock', HERDR_PANE_ID='w1:p2')
        body = capture.capture_payload(self.payload(), env, 'vps8-core')
        self.assertEqual(body['herdr']['pane_id'], 'w1:p2')
        self.assertEqual(body['herdr']['socket_path'], '/tmp/h.sock')
        env['HERDR_ENV'] = '0'
        self.assertNotIn('herdr', capture.capture_payload(self.payload(), env, 'vps8-core'))

    def test_delivery_is_bounded_and_failures_do_not_leak_secrets(self):
        with patch.object(capture.sys, 'stdin', io.StringIO(json.dumps(self.payload()))), \
             patch.object(capture, 'config', return_value={'SESSION_MINDER_TOKEN': 'secret', 'SESSION_MINDER_HOST_NAME': 'vps8-core'}), \
             patch.object(capture, 'report_herdr'), \
             patch.object(capture, 'session_name', return_value=None), \
             patch.object(capture.urllib.request, 'urlopen', side_effect=OSError('secret')) as send, \
             patch.object(capture.sys, 'stderr', io.StringIO()) as err:
            capture.main()
            self.assertEqual(send.call_args.kwargs['timeout'], 1.5)
            self.assertNotIn('secret', err.getvalue())

    def test_imports_only_explicit_names_not_prompt_derived_titles(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = sqlite3.connect(str(Path(directory) / 'state_5.sqlite'))
            conn.execute('CREATE TABLE threads (id TEXT, name TEXT, title TEXT)')
            conn.execute('INSERT INTO threads VALUES (?, NULL, ?)', (ID, 'private first prompt'))
            conn.commit()
            self.assertIsNone(capture.session_name(ID, {'CODEX_HOME': directory}))
            conn.execute('UPDATE threads SET name = ?', ('Integration',))
            conn.commit()
            self.assertEqual(capture.session_name(ID, {'CODEX_HOME': directory}), 'Integration')
            conn.close()


if __name__ == '__main__':
    unittest.main()
