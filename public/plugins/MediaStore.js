import { registerPlugin } from '@capacitor/core';

export const MediaStore = registerPlugin('MediaStore', {
  web: () => ({
    saveImage: async () => {
      throw new Error("MediaStore not supported on web");
    }
  })
});
