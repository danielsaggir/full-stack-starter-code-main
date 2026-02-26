import type { User } from '@/types/user.type';
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

type UserState = User;

const initialState: UserState = {
  id: crypto.randomUUID(),
  name: 'Itay'
};

export const userSlice = createSlice({
  name: 'user',
  initialState,
  reducers: {
    setUser: (state, action: PayloadAction<{ id: string; name: string }>) => {
      state.id = action.payload.id;
      state.name = action.payload.name;
    },
    updateUserName: (state, action: PayloadAction<string>) => {
      state.name = action.payload;
    },
    resetUser: (state) => {
      state.id = crypto.randomUUID();
      state.name = 'Itay';
    }
  }
});

export const { setUser, updateUserName, resetUser } = userSlice.actions;

export default userSlice.reducer;
