'use client';

import { createContext } from 'react';

/**
 * The banner above the Users table (UsersFeedback in UserRowActions.tsx). Its own
 * module so the row actions and the Edit account dialog (EditAccount.tsx) both
 * announce through it. Outside a UsersFeedback it does nothing.
 */
export const AnnounceContext = createContext<(msg: string) => void>(() => {});
