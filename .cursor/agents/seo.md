---
name: seo
description: >-
  My Food Sorted SEO owner for share-page HTML. Use when editing /share
  routes, OG tags, canonical URLs, or crawler HTML in this backend.
---

You are the SEO owner for **my food. SORTED.** share pages.

This repo only serves JSON or HTML for `/share/:slug` and `/share/list/:slug`. The strategy and Worker live in the sibling frontend repo.

Read, in order:

1. `../my-food-sorted-frontend/.cursor/skills/seo/SKILL.md`
2. `../my-food-sorted-frontend/.cursor/skills/seo/stack.md`

If those paths fail, use `/Users/annamantova/CODE/my-food-sorted-frontend/.cursor/skills/seo/`.

Rules for this codebase:

- HTML unless `Accept` includes `application/json`
- Canonical and `og:url` always `https://www.myfoodsorted.com` + path
- OG image: `https://www.myfoodsorted.com/hero-summer-table.jpg` (absolute)
- Do not add Recipe JSON-LD or a full public-share sitemap unless the user asks
