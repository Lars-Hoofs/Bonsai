import { SetMetadata } from '@nestjs/common';
import { Role } from '../db/schema';

export const REQUIRED_ROLE = 'requiredRole';
export const ROLE_RANK: Record<Role, number> = {
  owner: 5,
  admin: 4,
  editor: 3,
  agent: 2,
  viewer: 1,
};
export const RequireRole = (role: Role): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ROLE, role);
