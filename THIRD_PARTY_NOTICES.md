# Third-party notices

## Project Nayuki — QR Code generator

The QR encoder in `tgcloud/lib/vendor/qrcodegen.js` is compiled from the
unmodified upstream TypeScript source stored as `docs/vendor/qrcodegen.ts`.
Pinned-source metadata is stored in `docs/vendor/qrcodegen-source.json`.
The sole addition to the compiled JavaScript is an ES-module export.
An equivalent embedded copy is included in `tools/print-qr.html` so printing
also works offline without loading scripts from a third-party server.

- Project: https://www.nayuki.io/page/qr-code-generator-library
- Repository: https://github.com/nayuki/QR-Code-generator
- Upstream commit: `3c6d0b3cefb4e049dc337e82237c9644399716a8`
- Source: https://raw.githubusercontent.com/nayuki/QR-Code-generator/3c6d0b3cefb4e049dc337e82237c9644399716a8/typescript-javascript/qrcodegen.ts
- Source SHA-256: `1dc03fb5a10e0e2318ea162755bbdb9977ca6ce52cff959e9c9b6deafdccda9c`
- Build: TypeScript 5.9.3, target ES2020, comments retained.
- License: MIT, reproduced below and retained in the source files.

> Copyright (c) Project Nayuki. (MIT License)
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of
> this software and associated documentation files (the "Software"), to deal in
> the Software without restriction, including without limitation the rights to
> use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
> the Software, and to permit persons to whom the Software is furnished to do so,
> subject to the following conditions:
> - The above copyright notice and this permission notice shall be included in
>   all copies or substantial portions of the Software.
> - The Software is provided "as is", without warranty of any kind, express or
>   implied, including but not limited to the warranties of merchantability,
>   fitness for a particular purpose and noninfringement. In no event shall the
>   authors or copyright holders be liable for any claim, damages or other
>   liability, whether in an action of contract, tort or otherwise, arising from,
>   out of or in connection with the Software or the use or other dealings in the
>   Software.

The PNG writer and offline print-page interface are original project code.
Neither the deployed bot nor the print page requires npm packages at runtime.
