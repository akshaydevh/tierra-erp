# Tierra Evolution API

Patched Evolution API 2.3.7, copied from the DODO project (`infra/evolution`). The image pins commit `cd800f2976e1e5b682fbf86a01ee4d85ae61f370` and applies the four patches in `patches/`.

The linked-device label is set by Compose as Chrome (Tierra), not in this Dockerfile.

Build from the repository root:

```sh
docker compose build evolution
```
