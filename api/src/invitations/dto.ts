import { IsEmail, IsIn, IsString, Length } from 'class-validator';
import type { Role } from '../db/schema';

export class CreateInvitationDto {
  @IsEmail() email!: string;
  @IsIn(['admin', 'editor', 'agent', 'viewer']) role!: Exclude<Role, 'owner'>;
}

export class AcceptInvitationDto {
  @IsString() @Length(1, 512) token!: string;
}
