export type DocumentAttachmentResponse = {
  setHeader(name: string, value: string | number): void;
  end(bytes: Buffer): void;
};

export function sendDocumentAttachment(
  response: DocumentAttachmentResponse,
  documentId: string,
  file: {
    bytes: Buffer;
    contentType: 'application/pdf' | 'image/jpeg' | 'image/png';
  },
) {
  const extension =
    file.contentType === 'application/pdf'
      ? 'pdf'
      : file.contentType === 'image/jpeg'
        ? 'jpg'
        : 'png';
  response.setHeader('Content-Type', file.contentType);
  response.setHeader('Content-Length', file.bytes.length);
  response.setHeader(
    'Content-Disposition',
    `attachment; filename="document-${documentId}.${extension}"`,
  );
  response.end(file.bytes);
}
