import type { Viewer } from '@dezon/core';
import type { AuthUser } from '@dezon/shared';

export const toViewer = (user: AuthUser): Viewer => ({ id: user.id, role: user.role });
