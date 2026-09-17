# Attribution

This project is a TypeScript and Bun port of [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast), originally published by Browser Use under the MIT License.

The port began from upstream commit [`452c1ad2dd628008f1d5608f28158d76e49e6cc0`](https://github.com/browser-use/jev-ultrafast/commit/452c1ad2dd628008f1d5608f28158d76e49e6cc0). The original copyright and MIT license are preserved in `LICENSE`.

The observed-element snapshot policy, speculative TypeSafe operation/target choice design, stale-page guards, bounded action loop, and text-helper separation are derived from that source. This port replaces the Python runtime and Browser Harness Python client with Bun, TypeScript, and a small direct Chrome DevTools Protocol client. It also makes the action limit, foreground tab, and retained-tab behavior configurable.

TypeSafe and Jev are products of [TypeSafe AI](https://typesafe.ai/). This project is an independent port and is not an official Browser Use or TypeSafe AI project.
