# Publishing

Publishing is handled by GitHub Actions when you push a `v*` tag that matches `package.json`.

Example:

```bash
npm version patch
git push origin master --follow-tags
```