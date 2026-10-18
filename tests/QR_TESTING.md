# QR checks

## Default test run: Node only

```sh
node --test tests/qr.test.mjs
```

The default run needs neither Python nor Python packages. It checks the PNG
stream, white margins, rendering options, invalid inputs, and the offline
print page's support for a 32-character bot name with a `c_` + 48-hex-digit
token. The print page's embedded QR engine is executed without a browser and
must produce the same PNG bytes as the bot module.

The optional independent decoding test reports an explicit skip until
`QR_TEST_DECODER_PATH` is set.

## Full run with an independent decoder

From the project root, install the test dependencies into a separate directory:

```sh
python3 -m pip install --target /tmp/contact-for-thing-qr-qa -r tests/requirements-qr.txt
QR_TEST_DECODER_PATH=/tmp/contact-for-thing-qr-qa node --test tests/qr.test.mjs
```

Use `QR_TEST_PYTHON=/path/to/python3` if the test must use a specific Python
interpreter. `QR_TEST_DECODER_PATH` only affects the test subprocess's import
path; it does not change the deployed application or install global packages.
If the optional test is explicitly enabled but its interpreter or packages
are missing, it fails instead of silently skipping.

ZXing decodes five PNGs and compares their complete payloads: the maximum bot
name with a 48-hex token, another bot link at a smaller scale, Unicode text,
a one-character payload, and a large QR at the rendering-option boundaries.

Some process sandboxes block nested Node/Python processes. In that situation,
run this same local test command with the environment's approved permission
for subprocesses. The decoder makes no network requests during the test.

The deployed code and the offline print page have no npm or Python runtime
dependencies. Upstream QR source and provenance live in `docs/vendor/`;
only the compiled JavaScript is included under `tgcloud/lib/vendor/`.
