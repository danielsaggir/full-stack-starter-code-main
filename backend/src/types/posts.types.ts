export type CreatePostBody = {
  createdBy: string;
  title: string;
  content: string;
};

export type UpdatePostBody = {
  title: string;
  content: string;
};
