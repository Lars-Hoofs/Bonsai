# Bonsai backend roadmap — 50 self-hosted features

All self-hostable, no paid external service (Docker containers allowed:
Tesseract for OCR, Whisper for transcription; SMTP is self-hosted). Built
sequentially, each committed + pushed with tests, CI green.

Legend: [ ] todo · [x] done (commit).

## A. Widget builder & styling
- [ ] 1 Full theme schema (colors, gradients, radius, typography, spacing, shadow), validated + versioned
- [ ] 2 Theme presets/gallery, one-click apply
- [ ] 3 Draft vs published theme + shareable preview link (token)
- [ ] 4 Launcher customizer (icon/gradient, size, corner, offset)
- [ ] 5 Opening animations + delay
- [ ] 6 Welcome message + suggestion/quick-reply buttons editor
- [ ] 7 Bot + agent avatars per project
- [ ] 8 Sanitized custom-CSS field
- [ ] 9 Theme import/export (JSON) between projects
- [ ] 10 WCAG contrast check on save

## B. Widget behavior & visitor UX
- [ ] 11 Page-targeting rules (URL patterns)
- [ ] 12 Proactive triggers (after N sec / scroll / exit-intent)
- [ ] 13 Persist conversation across reloads (resume via id+secret)
- [ ] 14 Visitor file/image attach (stored in MinIO)
- [ ] 15 "Email me this transcript" (self-hosted SMTP)
- [ ] 16 Multi-language widget copy

## C. Knowledge base & sources
- [ ] 17 Manual Q&A/article editor (rich-text -> markdown) + categories/tags
- [ ] 18 Bulk KB import/export (JSON/CSV/Markdown zip)
- [ ] 19 Per-source re-crawl schedule + "crawl now" + last status
- [ ] 20 Source health overview + one-click reprocess
- [ ] 21 Per-document enable/disable (exclude from retrieval)
- [x] 22 Chunk inspector (view/search/edit/delete chunks)
- [x] 23 Synonyms/alias dictionary per project
- [ ] 24 OCR for scanned PDFs via self-hosted Tesseract (Docker)
- [ ] 25 Video/audio transcription via self-hosted Whisper (Docker)

## D. Answer quality & RAG
- [ ] 26 Retrieval debug view (chunks + scores + cited)
- [ ] 27 Multi-turn context in retrieval/answer
- [ ] 28 Answer templates / canned answers per intent
- [ ] 29 Configurable fallback chain (KB -> connector -> human)
- [ ] 30 A/B testing of prompts/thresholds via eval runner
- [ ] 31 Profanity/abuse filter on visitor input
- [ ] 32 "Did this answer your question?" inline -> unanswered questions
- [x] 33 Per-project settings API (confidence, verification mode, tool-calling, business-hours...)

## E. Conversations & handover
- [ ] 34 Internal notes on conversations (agent-only)
- [ ] 35 Canned responses/macros for agents
- [ ] 36 Conversation tags + saved filters + search
- [ ] 37 Status workflow (open/pending/resolved) + SLA timers
- [ ] 38 Handover notifications (webhook/Slack-incoming-webhook + SMTP)
- [ ] 39 Transfer conversation between agents
- [ ] 40 Auto-close idle conversations + post-chat survey

## F. Analytics & insight
- [ ] 41 Unanswered-questions clustering -> KB suggestions
- [ ] 42 Topic/intent analytics
- [x] 43 Cost/usage analytics per project (from metrics)
- [ ] 44 Deflection rate & trends over time
- [ ] 45 Exportable reports (CSV/JSON) + scheduled generation

## G. Team, admin, security & compliance
- [x] 46 Invitations & onboarding (SMTP)
- [ ] 47 GDPR data export + right-to-erasure + retention auto-purge
- [x] 48 Audit-log viewer + export with filters
- [ ] 49 TOTP/2FA for dashboard users
- [ ] 50 Plan/tier limits (projects/sources/seats), self-managed
