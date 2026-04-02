# Hermes Logo Pack (Reusable)

Canonical source:
- `hermes-logo-master.png` (1024x1024, transparent)

Design constraints:
- Single sandal
- Exactly 2 wings
- Wings attached only at back/heel
- No wing on toe/front
- Transparent background

Published variants:
- `../hermes-logo.png` (754x754)
- `../hermes-logo-128.png` (128x128)
- `hermes-logo-512.png`
- `hermes-logo-256.png`

Generation source snapshot:
- `hermes-logo-golden-raw.png`

Regenerate variants:
```bash
convert resources/logo/hermes-logo-master.png -resize 754x754 resources/hermes-logo.png
convert resources/logo/hermes-logo-master.png -resize 128x128 resources/hermes-logo-128.png
convert resources/logo/hermes-logo-master.png -resize 512x512 resources/logo/hermes-logo-512.png
convert resources/logo/hermes-logo-master.png -resize 256x256 resources/logo/hermes-logo-256.png
```
