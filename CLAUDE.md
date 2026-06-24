# Working notes for this repo

**This is a PUBLIC repository.** Follow these rules on every change.

## Attribution
- Commits must reference **only the owner: sliftist <sliftist@gmail.com>**.
- **Never** add Claude / AI as an author, committer, or `Co-Authored-By:` trailer.
- Do **not** add `Claude-Session` or any AI-tooling trailers to commit messages.

## Secrets (public repo)
- Never commit private information, credentials, tokens, passwords, or keys.
- SSH / deploy keys live outside the repo (in `~/.ssh`) — keep it that way.
- Keep `.gitignore` clean and covering secret patterns at all times.
- Review `git status` and `git diff` for anything sensitive **before every push**.
