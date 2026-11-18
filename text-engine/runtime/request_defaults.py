"""Chat defaults shared by browser and OpenAI-compatible coding clients."""

import json


def apply_defaults(data, visible_output=False):
    if not isinstance(data, dict):
        return data
    extra = data.get("vllm_xargs")
    if isinstance(extra, dict):
        extra.pop("b70_visible_tokens", None)
    field = "max_completion_tokens" if data.get("max_completion_tokens") is not None else "max_tokens"
    requested = data.get(field)
    if requested is None:
        data["max_tokens"] = 16384
    budget = data.get("thinking_token_budget")
    if budget is None or budget == -1:
        data["thinking_token_budget"] = 8192
    elif type(budget) is int and budget > 8192:
        data["thinking_token_budget"] = 8192
    data.setdefault("reasoning_effort", "medium")
    kwargs = data.get("chat_template_kwargs")
    if kwargs is None:
        kwargs = {}
        data["chat_template_kwargs"] = kwargs
    if isinstance(kwargs, dict):
        kwargs.setdefault("enable_thinking", data["reasoning_effort"] != "none")
        kwargs.setdefault("preserve_thinking", True)
        budget = data["thinking_token_budget"]
        if (visible_output and type(requested) is int and 0 < requested <= 262144
                and kwargs["enable_thinking"] is True and type(budget) is int and budget > 0
                and not data.get("use_beam_search")
                and not data.get("continue_final_message")
                and data.get("add_generation_prompt", True)):
            extra = data.setdefault("vllm_xargs", {})
            if isinstance(extra, dict):
                extra["b70_visible_tokens"] = requested
                # Qwen's parser consumes a special tool-call opener even with
                # no tools registered, leaving an otherwise successful reply empty.
                if not data.get("tools") or data.get("tool_choice") == "none":
                    blocked = data.setdefault("bad_words", [])
                    if isinstance(blocked, list) and "<tool_call>" not in blocked:
                        blocked.append("<tool_call>")
    return data


class ChatDefaults:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or scope.get("path") != "/v1/chat/completions"
        ):
            return await self.app(scope, receive, send)
        chunks = []
        while True:
            event = await receive()
            if event["type"] == "http.disconnect":
                return
            chunks.append(event.get("body", b""))
            if not event.get("more_body", False):
                break
        body = b"".join(chunks)
        try:
            data = json.loads(body)
            visible = (b"x-b70-output-budget", b"visible") in scope.get("headers", ())
            body = json.dumps(apply_defaults(data, visible)).encode()
        except (ValueError, UnicodeError):
            pass  # The normal API validator reports malformed input.
        scope = dict(scope)
        scope["headers"] = [
            (key, value)
            for key, value in scope.get("headers", [])
            if key.lower() != b"content-length"
        ]
        scope["headers"].append((b"content-length", str(len(body)).encode()))
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)
