"""Offline derivation from saved native-client and HTTP records; no model calls."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "artifacts/claude-kimi-mcp-20261028"


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sse(path):
    events = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("data: "):
            try:
                events.append(json.loads(line[6:]))
            except json.JSONDecodeError:
                pass
    return events


def wire_response(path):
    events = sse(path)
    usage = {}
    texts = []
    blocks = []
    for event in events:
        usage.update(event.get("message", {}).get("usage", {}))
        usage.update(event.get("usage", {}))
        if event.get("type") == "content_block_start":
            block = event.get("content_block", {})
            blocks.append(block.get("type"))
            if block.get("type") == "text":
                texts.append(block.get("text", ""))
        delta = event.get("delta", {})
        if delta.get("type") == "text_delta":
            texts.append(delta.get("text", ""))
    return {
        "usage": usage,
        "reportedInputTotal": sum(usage.get(key, 0) for key in (
            "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")),
        "blockTypes": blocks,
        "ordinaryText": "".join(texts),
    }


def native_events(path):
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    texts, calls, errors = [], [], []
    for row in rows:
        if row.get("role") == "assistant" and isinstance(row.get("content"), str):
            texts.append(row["content"])
        calls.extend(call["function"]["name"] for call in row.get("tool_calls", []))
        message = row.get("message", {})
        content = message.get("content", []) if isinstance(message, dict) else row.get("content", [])
        if not message:
            content = row.get("content", [])
        if isinstance(content, list):
            for block in content:
                if block.get("type") == "text":
                    texts.append(block.get("text", ""))
                if block.get("type") == "tool_use":
                    calls.append(block.get("name"))
                if block.get("type") == "tool_result" and block.get("is_error"):
                    errors.append(str(block.get("content"))[:300])
        if row.get("role") == "tool" and re.search(
                r"Invalid args|denied|not permitted|not allowed|ERROR", str(content), re.I):
            errors.append(str(content)[:300])
    return {"ordinaryText": "".join(texts), "toolCalls": calls, "errors": errors}


cases = []
for directory in sorted(ROOT.iterdir()):
    if not (directory / "result.json").exists():
        continue
    result = read(directory / "result.json")
    native = native_events(directory / "stdout.jsonl")
    requests = []
    for path in sorted(directory.glob("http-*-request.json")):
        body = read(path)
        response_path = path.with_name(path.name.replace("-request.json", "-response.txt"))
        response = wire_response(response_path) if response_path.exists() else {}
        tools = body.get("tools", [])
        loaded_read = [tool for tool in tools if "cat_cafe_read_file_slice" in tool.get("name", "")]
        serialized = dump(body)
        requests.append({
            "file": path.name,
            "wireBytes": read(path.with_name(path.name.replace("-request.json", "-meta.json")))["bytes"],
            "toolCount": len(tools),
            "mcpToolCount": sum(tool.get("name", "").startswith("mcp__") for tool in tools),
            "deferredCount": sum(bool(tool.get("defer_loading")) for tool in tools),
            "thinking": body.get("thinking"),
            "readSchemaRequired": [tool.get("input_schema", {}).get("required") for tool in loaded_read],
            "startLineOccurrences": serialized.count("startLine"),
            **response,
        })
    excluded = directory.name in ("claude-full-host-default-native", "kimi-full-host-default-native")
    final_wire_text = requests[-1].get("ordinaryText", "")
    cases.append({
        "case": directory.name,
        "excludeFromTaskComparison": excluded,
        "exclusionReason": "early permission/relative-path sample" if excluded else None,
        "agent": result["agent"],
        "version": result["version"],
        "promptDigest": result["promptDigest"],
        "roleDigest": result["roleDigest"],
        "keyDigest": result["keyDigest"],
        "declaredMcpTools": result["declaredMcpTools"],
        "exitCode": result.get("code"),
        "elapsedMs": result["elapsedMs"],
        "toolCalls": native["toolCalls"],
        "toolErrors": native["errors"],
        "ordinaryText": native["ordinaryText"],
        "finalWireText": final_wire_text,
        "finalHasEnglishPreamble": bool(re.match(r"\s*[A-Za-z]", final_wire_text)),
        "finalCjkCharacters": len(re.findall(r"[\u4e00-\u9fff]", final_wire_text)),
        "requests": requests,
    })

schemas = read(ROOT / "schemas.json")
tools = [dict(server=server, **tool) for server, entries in schemas.items() for tool in entries]
accounting = []
for tool in tools:
    accounting.append({
        "server": tool["server"], "name": tool["name"],
        "descriptionChars": len(tool.get("description", "")),
        "inputSchemaChars": len(dump(tool["inputSchema"])),
        "definitionChars": len(dump({key: value for key, value in tool.items() if key != "server"})),
    })
accounting.sort(key=lambda item: item["definitionChars"], reverse=True)
summary = {
    "metricNote": "reportedInputTotal uses final supplier usage: input+cache creation+cache read; not a tokenizer measurement or price. The supplier changes input counts between stream start and final delta.",
    "cases": cases,
    "schemaAccounting": {
        "mcpTools": len(tools),
        "definitionChars": sum(tool["definitionChars"] for tool in accounting),
        "descriptionChars": sum(tool["descriptionChars"] for tool in accounting),
        "inputSchemaChars": sum(tool["inputSchemaChars"] for tool in accounting),
        "byServer": {
            server: {"tools": len(entries), "definitionChars": sum(
                tool["definitionChars"] for tool in accounting if tool["server"] == server)}
            for server, entries in schemas.items()
        },
        "largestTools": accounting[:10],
    },
}
(ROOT / "comparison-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
for case in cases:
    first = case["requests"][0]
    print(dump({"case": case["case"], "excluded": case["excludeFromTaskComparison"],
                "tools": first["toolCount"], "bytes": first["wireBytes"],
                "reportedInput": first["reportedInputTotal"], "calls": case["toolCalls"],
                "english": case["finalHasEnglishPreamble"], "cjk": case["finalCjkCharacters"]}))
print(dump(summary["schemaAccounting"]))
