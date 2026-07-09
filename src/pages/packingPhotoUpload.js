export async function uploadPackingPhotos({
  files,
  orderId,
  processId,
  workerName,
  uploadPhoto,
  createFormData = () => new FormData(),
}) {
  return Promise.all((files || []).map((file) => {
    const formData = createFormData();
    formData.append('photo', file);
    formData.append('order_id', orderId);
    formData.append('process_id', processId);
    formData.append('uploaded_by', workerName);
    return uploadPhoto(formData);
  }));
}
