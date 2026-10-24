import io
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from parrot_app import application
from scripts.managed_runtime import validate_source


class ParrotWsgiTests(unittest.TestCase):
    def call(self, path, method="GET", token=None, payload=None):
        raw = b"" if payload is None else json.dumps(payload).encode("utf-8")
        environ = {
            "REQUEST_METHOD": method,
            "PATH_INFO": path,
            "CONTENT_LENGTH": str(len(raw)) if payload is not None else "",
            "wsgi.input": io.BytesIO(raw),
        }
        if token is not None:
            environ["HTTP_AUTHORIZATION"] = f"Bearer {token}"
        captured = {}

        def start_response(status, headers):
            captured["status"] = int(status.split()[0])
            captured["headers"] = dict(headers)

        body = b"".join(application(environ, start_response))
        return captured["status"], json.loads(body.decode("utf-8")), captured["headers"]

    def settings(self):
        return patch.dict(os.environ, {
            "PARROT_SERVICE_TOKEN": "test-service-token",
            "PARROT_ALLOWED_SOURCES": "hawk,eagle,owl,admin",
            "PARROT_MAX_INPUT_BYTES": "131072",
            "PARROT_MAX_OUTPUT_BYTES": "65536",
        }, clear=False)

    def test_health_reports_ready_without_exposing_configuration(self):
        with self.settings():
            status, body, headers = self.call("/healthz")
        self.assertEqual(status, 200)
        self.assertTrue(body["ready"])
        self.assertEqual(body["contractVersion"], "parrot.v1")
        self.assertNotIn("token", body)
        self.assertTrue(headers["X-Request-Id"])

    def test_catalog_requires_the_service_token(self):
        with self.settings():
            denied, denied_body, _ = self.call("/v1/catalog")
            allowed, body, _ = self.call("/v1/catalog", token="test-service-token")
        self.assertEqual(denied, 401)
        self.assertEqual(denied_body["code"], "PARROT_UNAUTHORIZED")
        self.assertEqual(allowed, 200)
        self.assertIn("text.normalize", [item["id"] for item in body["scripts"]])
        self.assertTrue(all("handler" not in item for item in body["scripts"]))

    def test_registered_run_redacts_credentials_and_returns_metrics(self):
        payload = {
            "contractVersion": "parrot.v1",
            "source": "hawk",
            "mode": "dry_run",
            "scriptId": "system.echo",
            "inputs": {"value": 7, "accessToken": "must-not-return"},
            "context": {"locationId": "location-1"},
            "limits": {"timeoutMs": 1000},
        }
        with self.settings():
            status, body, _ = self.call("/v1/runs", "POST", "test-service-token", payload)
        self.assertEqual(status, 200)
        self.assertEqual(body["output"]["received"]["value"], 7)
        self.assertEqual(body["output"]["received"]["accessToken"], "[redacted]")
        self.assertGreaterEqual(body["metrics"]["durationMs"], 0)

    def test_script_policy_and_version_fail_closed(self):
        base = {
            "contractVersion": "parrot.v1",
            "source": "hawk",
            "mode": "live",
            "scriptId": "system.echo",
            "inputs": {},
            "context": {},
        }
        with self.settings():
            denied, denied_body, _ = self.call("/v1/runs", "POST", "test-service-token", base)
            wrong_version, version_body, _ = self.call("/v1/runs", "POST", "test-service-token", {
                **base, "mode": "dry_run", "scriptVersion": "9.9.9"
            })
        self.assertEqual(denied, 403)
        self.assertEqual(denied_body["code"], "PARROT_SCRIPT_POLICY_DENIED")
        self.assertEqual(wrong_version, 404)
        self.assertEqual(version_body["code"], "PARROT_SCRIPT_VERSION_NOT_FOUND")

    def test_text_normalizer_executes_in_live_mode(self):
        payload = {
            "contractVersion": "parrot.v1",
            "source": "admin",
            "mode": "live",
            "scriptId": "text.normalize",
            "inputs": {"text": "  Hello   PARROT  ", "case": "lower"},
            "context": {},
        }
        with self.settings():
            status, body, _ = self.call("/v1/runs", "POST", "test-service-token", payload)
        self.assertEqual(status, 200)
        self.assertEqual(body["output"]["text"], "hello parrot")
        self.assertEqual(body["output"]["words"], 2)

    def test_managed_source_validates_and_runs_in_dry_run(self):
        source = "def run(inputs, context):\n    return {'total': sum(inputs.get('values', [])), 'dryRun': context.get('dryRun')}\n"
        with self.settings():
            validated, validation_body, _ = self.call("/v1/source/validate", "POST", "test-service-token", {
                "source": source, "capabilities": []
            })
            payload = {
                "contractVersion": "parrot.v1", "source": "hawk", "mode": "dry_run",
                "scriptId": "custom.inline-test", "scriptVersion": "1", "inputs": {"values": [2, 3, 5]},
                "context": {}, "sourcePackage": {
                    "source": source, "sha256": validation_body["validation"]["sha256"],
                    "version": "1", "capabilities": [], "approved": False,
                },
            }
            status, body, _ = self.call("/v1/runs", "POST", "test-service-token", payload)
        self.assertEqual(validated, 200)
        self.assertTrue(validation_body["validation"]["valid"])
        self.assertEqual(status, 200)
        self.assertEqual(body["output"], {"total": 10, "dryRun": True})
        self.assertTrue(body["script"]["managed"])

    def test_managed_source_blocks_imports_and_unapproved_live_runs(self):
        denied_source = "import os\ndef run(inputs, context):\n    return {}\n"
        valid_source = "def run(inputs, context):\n    return {'ok': True}\n"
        with self.settings():
            _, denied, _ = self.call("/v1/source/validate", "POST", "test-service-token", {"source": denied_source})
            _, valid, _ = self.call("/v1/source/validate", "POST", "test-service-token", {"source": valid_source})
            status, body, _ = self.call("/v1/runs", "POST", "test-service-token", {
                "contractVersion": "parrot.v1", "source": "hawk", "mode": "live",
                "scriptId": "custom.unapproved", "inputs": {}, "context": {},
                "sourcePackage": {"source": valid_source, "sha256": valid["validation"]["sha256"], "capabilities": [], "approved": False},
            })
        self.assertFalse(denied["validation"]["valid"])
        self.assertEqual(status, 403)
        self.assertEqual(body["code"], "PARROT_SOURCE_APPROVAL_REQUIRED")

    def test_managed_source_rejects_executable_function_signatures(self):
        source = "def run(inputs=http_get('https://example.com'), context=None):\n    return inputs\n"
        with self.settings():
            status, body, _ = self.call(
                "/v1/source/validate", "POST", "test-service-token",
                {"source": source, "capabilities": ["network.http"]},
            )
        self.assertEqual(status, 200)
        self.assertFalse(body["validation"]["valid"])
        self.assertIn(
            "PARROT_SOURCE_SIGNATURE_DENIED",
            {item["code"] for item in body["validation"]["errors"]},
        )

    def test_portable_sample_is_valid_managed_python(self):
        sample_path = Path(__file__).resolve().parents[1] / "public" / "data" / "parrot-script-template.json"
        package = json.loads(sample_path.read_text(encoding="utf-8"))
        self.assertEqual(package["format"], "parrot-script-1")
        script = package["scripts"][0]
        validation = validate_source(script["source"], script["capabilities"])
        self.assertTrue(validation["valid"], validation["errors"])
        self.assertEqual(validation["helpers"], [])


if __name__ == "__main__":
    unittest.main()
