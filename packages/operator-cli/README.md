# Operator CLI

A dependency-free client for the existing Cat Cafe Host HTTP API. Requires Node.js 24 or later. From a checkout install it with `npm install -g ./packages/operator-cli`, or run `node packages/operator-cli/bin/cat-cafe.mjs --help`. The package can also be installed from a packed tarball using npm. This is separate from the cats' agent CLIs and MCP tools.

```sh
export CAT_CAFE_BASE_URL=http://127.0.0.1:3004
export CAT_CAFE_USER=default-user
cat-cafe whoami
cat-cafe threads list
cat-cafe cats list
cat-cafe messages send --thread THREAD_ID --text 'Hello' --mention CAT_ID
cat-cafe messages list --thread THREAD_ID --limit 20
```

The URL defaults to `http://127.0.0.1:3004` and must be an HTTP(S) origin. Set `CAT_CAFE_USER` to the identity accepted by the Host's non-browser `X-Cat-Cafe-User` path, or set `CAT_CAFE_SESSION_COOKIE` to an existing complete Cookie header such as `cat_cafe_session=...`. The Host prioritizes a session over the user header; the CLI checks a supplied session with `/api/session` before each operation and rejects a newly issued session. It does not extract browser cookies automatically. Keep cookie values secret and use HTTPS for remote connections. A user header is an identity assertion, not a cryptographic credential; only use it with a trusted Host/network. Bearer tokens are not supported by these Host routes.

`whoami` checks connectivity and reports the configured header identity as `verified: false`, because the Host session endpoint does not resolve that header. With a valid cookie it reports the server's session user as `verified: true`. `--mention` accepts a cat ID from `cats list` and sends the existing API's explicit `mentions` field. Message send confirms the Host response, not completion of any cat response.

Successful operations print the Host's JSON response to stdout (except `whoami`, which prints its identity summary). Errors go to stderr; exit codes are 0 success, 2 usage/configuration error, 3 HTTP or rejected session, and 4 transport/invalid response. Requests time out after 30 seconds and are not automatically retried; a failed send may have reached the server, so inspect the thread before retrying.
