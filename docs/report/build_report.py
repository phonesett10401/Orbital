"""Assemble the three report chapters into one document, then render it.

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
date: "CSC480 --- 7 September 2026"
lang: en-GB
---
"""

CHAPTERS = [
    "chapter-1-introduction.md",
    "chapter-2-feasibility-and-related-work.md",
    "chapter-3-requirements-analysis.md",
]


def assemble() -> pathlib.Path:
    parts = [TITLE]
    for index, name in enumerate(CHAPTERS):
        text = (SRC / name).read_text(encoding="utf-8")
        # The use case diagram is 42 lines and was split across a page break,
        # which is not acceptable in a submitted report. It gets its own page.
        text = text.replace(
            "## 3.4 Use Case Diagram", PAGE_BREAK + "## 3.4 Use Case Diagram"
        )
        # Not before the first: pandoc's own table of contents already ends
        # its page, and a second break left page 2 blank.
        if index:
            parts.append(PAGE_BREAK)
        parts.append(text)
    combined = OUT / "orbital-report-chapters-1-3.md"
    combined.write_text("".join(parts), encoding="utf-8")
    return combined


def to_docx(md: pathlib.Path) -> pathlib.Path:
    docx = OUT / "Orbital-Report-Chapters-1-3.docx"
    subprocess.run(
        [
            "pandoc", str(md),
            "-o", str(docx),
            "--from",
            "markdown+pipe_tables+backtick_code_blocks+yaml_metadata_block+raw_attribute",
            "--toc", "--toc-depth=2",
            "--standalone",
            # The code style is 8pt rather than pandoc's 11pt: the use case
            # diagram is 73 characters wide and wrapped inside its own boxes
            # at the default size, destroying the ASCII alignment.
            "--reference-doc", str(OUT / "reference.docx"),
        ],
        check=True,
    )
    return docx


def to_pdf(docx: pathlib.Path) -> pathlib.Path:
    """Word's own export, so the PDF is the document rather than a re-render."""
    import win32com.client

    pdf = OUT / "Orbital-Report-Chapters-1-3.pdf"
    word = win32com.client.Dispatch("Word.Application")
    word.Visible = False
    try:
        doc = word.Documents.Open(str(docx), ReadOnly=False)
        try:
            for toc in doc.TablesOfContents:
                toc.Update()
            doc.SaveAs(str(pdf), FileFormat=17)  # wdExportFormatPDF
        finally:
            doc.Close(SaveChanges=True)
    finally:
        word.Quit()
    return pdf


if __name__ == "__main__":
    md = assemble()
    print("combined:", md.name, md.stat().st_size, "bytes")
    docx = to_docx(md)
    print("docx:    ", docx.name, docx.stat().st_size, "bytes")
    pdf = to_pdf(docx)
    print("pdf:     ", pdf.name, pdf.stat().st_size, "bytes")
