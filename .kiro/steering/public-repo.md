---
inclusion: always
---

# Public repository hygiene

This repository is public.

- Never commit credentials, API keys, session tokens, private server addresses or host names, SSH aliases, personal email addresses, or operational records of a private deployment (backup paths, release directories on a private server, evidence folders).
- Do not commit internal details of other products, such as AINovel's database layout or file paths. Disclose reused code in `docs/reuse-manifest.md` instead.
- Keep deployment logs and real-model evidence outside the repository, for example in the ignored `artifacts/` folder.
- Use placeholders such as `studio.example.com` in deployment templates and documentation.
