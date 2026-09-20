---
feature_ids: [F202]
topics: [plugin-manager, configuration, validation, console]
doc_kind: bug-report
created: 2026-09-17
updated: 2026-09-17
tips_exempt:
  reason: Correctness repair for the existing Plugin Manager configuration journey; no new top-level capability.
---

# F202 plugin configuration readiness and activation

## Bug diagnosis capsule

| Field | Evidence-backed diagnosis |
|---|---|
| **1. Symptom** | Saving an apparently complete Video Analysis configuration returned HTTP 200 without visible success feedback, while the activation toggle remained blocked. Clicking the blocked toggle highlighted the whole detail card instead of the missing required field. |
| **2. Evidence** | The manifest projects `provider` as a required select without an explicit default. The browser displayed its first option, Gemini, but the configuration request contained only fields the user had edited. The isolated feature inventory therefore remained `configReadiness: incomplete` after the successful write. |
| **3. Root cause** | The form had two different notions of value: native select rendering showed the first option, while request construction only serialized draft entries. No shared required-field validation or success state connected Save and prerequisite activation. |
| **4. Diagnosis strategy** | Trace manifest field metadata → projected form value → configuration request → refreshed lifecycle revision and readiness. Inspect only stored configuration keys, never secret values. Reproduce through component tests before changing behavior. |
| **5. Timeout strategy** | Component tests use deterministic API responses and effects. No production runtime, persistent user data, or unrelated localhost service is accessed. |
| **6. Early warning** | A required field must have one effective value across rendering, validation, and serialization. A successful configuration transaction must refresh the plugin revision before activation. |
| **7. User-visible correction** | Save and blocked activation now share manifest-driven required validation: only missing required inputs receive a red highlight and focus. A successful save shows `配置已保存`; the refreshed revision then permits activation. |
| **8. Acceptance** | Red-to-green tests prove the displayed implicit select value is sent, missing required fields share one validation path for Save and activation, success feedback is visible, and activation uses the refreshed lifecycle revision. Console visual-contract tests and Web type checking remain green. |

## Safety boundary

- Validation is generic over the manifest-projected `required` flag; there is no plugin-ID-specific branch.
- Existing masked secrets count as configured but are never copied into an update payload unless the user replaces them.
- Configuration contents are not logged or included in this report.
- The change is exercised only in the isolated F202 feature checkout and does not modify operator runtime configuration.
