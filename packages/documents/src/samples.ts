import { createStoredZip } from "./zip-write.js";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

export function samplePdfBytes(): Uint8Array {
  return pdfWithLines("Work Experience", "Shipped the export pipeline.");
}

export function linkedLabelPdfBytes(): Uint8Array {
  const stream = "BT\n/F1 12 Tf\n72 720 Td\n(LinkedIn) Tj\nET";
  const annot =
    "<< /Type /Annot /Subtype /Link /Rect [72 708 140 730] /Border [0 0 0] /A << /S /URI /URI (https://www.linkedin.com/in/mina-kapoor) >> >>";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [6 0 R] /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    annot,
  ];
  return pdfObjects(objects, stream);
}

export function linkedLabelDocxBytes(): Uint8Array {
  const encoder = new TextEncoder();
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body><w:p><w:hyperlink r:id="rId5"><w:r><w:t>LinkedIn</w:t></w:r></w:hyperlink></w:p></w:body>
</w:document>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.linkedin.com/in/mina-kapoor" TargetMode="External"/>
</Relationships>`;
  return createStoredZip([
    { name: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES) },
    { name: "word/document.xml", data: encoder.encode(documentXml) },
    { name: "word/_rels/document.xml.rels", data: encoder.encode(rels) },
  ]);
}

export function emptyPdfBytes(): Uint8Array {
  return pdfWithStream("0 0 20 20 re f");
}

export function corruptPdfBytes(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.4\nthis is not a readable pdf");
}

export function sampleDocxBytes(): Uint8Array {
  return docxWithParagraphs(
    "<w:p><w:r><w:t>Work Experience</w:t></w:r></w:p>",
    "<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Shipped the export pipeline.</w:t></w:r></w:p>",
  );
}

export function encryptedDocxBytes(): Uint8Array {
  const encoder = new TextEncoder();
  return createStoredZip([
    { name: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES) },
    { name: "EncryptionInfo", data: encoder.encode("encrypted") },
    { name: "EncryptedPackage", data: encoder.encode("encrypted") },
  ]);
}

function docxWithParagraphs(...paragraphs: string[]): Uint8Array {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs.join("")}</w:body>
</w:document>`;
  const encoder = new TextEncoder();
  return createStoredZip([
    { name: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES) },
    { name: "word/document.xml", data: encoder.encode(xml) },
  ]);
}

function pdfWithLines(first: string, second: string): Uint8Array {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escapePdf(first)}) Tj\n/F1 12 Tf\n0 -28 Td\n(${escapePdf(second)}) Tj\nET`;
  return pdfWithStream(stream);
}

function pdfWithStream(stream: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  return pdfObjects(objects, stream);
}

function pdfObjects(objects: Array<string | null>, stream: string): Uint8Array {
  const streamObject = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    const contents = index === 3 ? streamObject : object;
    body += `${index + 1} 0 obj\n${contents}\nendobj\n`;
  });
  const xrefAt = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

function escapePdf(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}
