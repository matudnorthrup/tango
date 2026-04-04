# printing_profile_selection

Reusable guidance for choosing print settings and reporting the pipeline clearly.

## Workflow

- Keep render, STL, and G-code paths explicit at each step.
- Verify printer status before upload or start.
- Report the exact file path, print profile, and material profile used.

## Profile selection

- Use `0.20mm SPEED @MK4IS 0.4` for quick fit checks and routine prototypes.
- Use `0.10mm FAST DETAIL` when surface detail matters more than speed.
- Use `0.15mm SPEED` for a balanced default when detail and speed both matter.
- Use `0.20mm STRUCTURAL` for stronger functional parts.

## Material selection

- Default to PLA for typical indoor prototypes.
- Prefer PETG when heat resistance, outdoor use, or extra toughness matters.

## MK4 G-code compatibility

- The MK4 firmware validates G-code with `M862.x` blocks. G-code missing these blocks will be rejected with "G-code isn't compatible" at the printer.
- PrusaSlicer 2.9.4 CLI has a known bug where `--printer-profile` doesn't resolve MK4 vendor bundle inheritance — see `agents/tools/printing.md` for the fix.
- Always verify sliced G-code contains `M862` lines before uploading.
- Use the pre-resolved profile at `~/Documents/3d-printing/opengrid/mk4is_profile.ini` for MK4IS prints.

## Infill by use case

- **5%** — organizers, cable management tiles, holders (saves hours of print time with no functional loss)
- **15%** — general default
- **20–40%** — functional/structural parts with load or stress
