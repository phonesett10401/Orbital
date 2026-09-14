"""Assemble the report chapters into one document, then render it.

Markdown -> .docx with pandoc, then .docx -> .pdf with Word itself, so the two
files are the same document rather than two separate renderings of it.
"""

from __future__ import annotations

import pathlib
import subprocess

REPO = pathlib.Path(r"C:\Orbital")
SRC = REPO / "docs" / "report"
# Not `build/`: .gitignore excludes that as compiled output, and these are
# documents for submission rather than artifacts nobody needs to keep.
OUT = SRC / "documents"
OUT.mkdir(parents=True, exist_ok=True)

# A page break Word honours.
#
# `\newpage` is a LaTeX command. Pandoc dropped it **silently** for a docx
# target - no error, no literal text in the output - so every chapter simply
# ran on from the bottom of the previous page. Found by checking which page
# each chapter actually started on rather than by trusting the build.
PAGE_BREAK = (
    "\n\n```{=openxml}\n"
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>\n'
    "```\n\n"
)

TITLE = """---
title: "Orbital"
subtitle: "Live Aircraft, Ship and Satellite Tracking --- Project Report"
author:
  - "Phone Sett Paing Kyaw (6708369)"
  - "Bhone Pyae Hein (6708381)"
  - "Han Phyo Htet (6708463)"
  - "Nyan Lin Htet (6708397)"
  - "Pyae Phyo Maung (6708170)"
date: "CSC480 --- 15 September 2026"
lang: en-GB
---
"""

CHAPTERS = [
    "chapter-1-introduction.md",
    "chapter-2-feasibility-and-related-work.md",
    "chapter-3-requirements-analysis.md",
    "chapter-4-project-planning.md",
    "chapter-5-system-design.md",
]

#: Stem for both built files. It names the range, so a stale document from an
#: earlier range is obvious in the folder rather than silently overwritten.
STEM = "Orbital-Report-Chapters-1-5"


def assemble() -> pathlib.Path:
    parts = [TITLE]
    for index, name in enumerate(CHAPTERS):
        text = (SRC / name).read_text(encoding="utf-8")
        # §3.4 is a full-width figure now rather than 42 lines of ASCII, but
        # it still wants its own page: a figure that starts four lines from the
        # bottom pushes its own caption onto the next one.
        text = text.replace(
            "## 3.4 Use Case Diagram", PAGE_BREAK + "## 3.4 Use Case Diagram"
        )
        # Not before the first: pandoc's own table of contents already ends
        # its page, and a second break left page 2 blank.
        if index:
            parts.append(PAGE_BREAK)
        parts.append(text)
    combined = OUT / f"{STEM.lower()}.md"
    combined.write_text("".join(parts), encoding="utf-8")
    return combined


def to_docx(md: pathlib.Path) -> pathlib.Path:
    docx = OUT / f"{STEM}.docx"
    subprocess.run(
        [
            "pandoc", str(md),
            "-o", str(docx),
            "--from",
            "markdown+pipe_tables+backtick_code_blocks+yaml_metadata_block"
            "+raw_attribute+link_attributes+implicit_figures",
            "--toc", "--toc-depth=2",
            "--standalone",
            # Pandoc resolves a relative image path against the *working
            # directory*, not against the file the path was written in. The
            # chapters say `figures/...` and the combined file is assembled one
            # level down in documents/, so without this every figure silently
            # resolves to nothing: pandoc emits no image and no error, and the
            # only symptom is a .docx with an empty media folder.
            "--resource-path", str(SRC),
            # The code style is 8pt rather than pandoc's 11pt: the use case
            # diagram is 73 characters wide and wrapped inside its own boxes
            # at the default size, destroying the ASCII alignment.
            "--reference-doc", str(OUT / "reference.docx"),
        ],
        check=True,
    )
    return docx


def to_pdf(docx: pathlib.Path) -> pathlib.Path:
    """Word's own export, so the PDF is the document rather than a re-render.

    Driven through PowerShell rather than `win32com`, which is not installed in
    every interpreter on this machine and made the build fail after the .docx
    had already been written - the worst possible place to fail, because the
    document looked finished and the PDF beside it was silently stale.
    PowerShell's COM support is part of Windows and needs nothing installed.

    The table of contents is updated before saving. Pandoc writes the TOC as a
    field, so a document opened without updating it shows the *previous* build's
    page numbers, which is a mistake nobody catches by looking at page one.
    """
    pdf = OUT / f"{STEM}.pdf"
    script = f"""
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {{
    $doc = $word.Documents.Open('{docx}', $false, $false)
    try {{
        foreach ($toc in $doc.TablesOfContents) {{ $toc.Update() | Out-Null }}
        $doc.SaveAs([ref]'{pdf}', [ref]17)
    }} finally {{ $doc.Close(-1) }}
}} finally {{ $word.Quit() }}
"""
    subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        check=True,
    )
    return pdf


if __name__ == "__main__":
    md = assemble()
    print("combined:", md.name, md.stat().st_size, "bytes")
    docx = to_docx(md)
    print("docx:    ", docx.name, docx.stat().st_size, "bytes")
    pdf = to_pdf(docx)
    print("pdf:     ", pdf.name, pdf.stat().st_size, "bytes")
