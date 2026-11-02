import json
import os
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import bw_reuse_audit  # noqa: E402


class WriteReportTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "report.json")
        self.old_umask = os.umask(0o022)

    def tearDown(self):
        os.umask(self.old_umask)
        self.dir.cleanup()

    def mode(self):
        return stat.S_IMODE(os.stat(self.path).st_mode)

    def test_new_file_is_owner_only(self):
        bw_reuse_audit.write_report(self.path, {"reused_groups": []})
        self.assertEqual(self.mode(), 0o600)

    def test_existing_readable_file_becomes_owner_only(self):
        with open(self.path, "w") as f:
            f.write("old")
        os.chmod(self.path, 0o644)
        bw_reuse_audit.write_report(self.path, {"reused_groups": []})
        self.assertEqual(self.mode(), 0o600)
        with open(self.path, encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"reused_groups": []})


if __name__ == "__main__":
    unittest.main()
