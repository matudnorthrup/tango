# travel_document_printing

Workflow guidance for printing travel confirmations, itineraries, reservations,
boarding passes, and similar paper backup documents.

## Workflow

- Read the user's trip note or packing list through Obsidian direct file access.
- Use email search to find confirmation messages and attachments from airlines,
  lodging, car rentals, events, and booking services.
- Prefer original PDFs from email attachments when available. Use generated text
  PDFs only for cover sheets, summaries, or confirmations that exist only in an
  email body.
- Download email attachments to `/tmp`, then use `paper_print` with `preview`
  to copy or convert each document into a stable local PDF.
- Run `paper_print` with `list_printers` before any real print attempt.
- Use `paper_print` with `action: "print"` and `dry_run: true` to show the
  exact print command first when the request is not already an explicit print
  request.
- Set `dry_run: false` only when the user has explicitly asked for physical hard
  copies and a CUPS printer destination is available.
- Never report that documents printed unless `paper_print` returns a successful
  `lp_output`.

## Privacy

- Do not copy raw personal itinerary details into tracked repo docs or Linear.
- Linear updates should mention generic evidence only: tool added, preview PDF
  generated, printer destination missing/configured, live test passed/blocked.
- Generated travel PDFs belong in the configured paper-print output directory or
  another private local user directory, not the repository.

## Document Set

For travel packet requests, look for:

- Flight confirmations and boarding passes
- Lodging confirmations and check-in instructions
- Ground transportation reservations
- Event tickets or activity reservations
- Travel insurance, emergency contacts, and any offline entry requirements the
  user explicitly names
