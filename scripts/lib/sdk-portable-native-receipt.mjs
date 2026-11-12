/** Keep compiler locations in external validation, while retaining its digest. */
export function portableNativeReceipt(receipt, evidenceSha256) {
  const portable = structuredClone(receipt);
  delete portable.targetDir;
  if (portable.cppAbiValidation) delete portable.cppAbiValidation.compileCommand;
  portable.producerEvidenceSha256 = evidenceSha256;
  return portable;
}
