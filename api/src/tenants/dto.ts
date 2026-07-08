import { IsEmail, IsIn, IsString, Length, Matches } from 'class-validator';
import { Role } from '../db/schema';

export class CreateTenantDto {
  @IsString() @Length(2, 100) name!: string;
  @Matches(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/) slug!: string;
}

export class AddMemberDto {
  @IsEmail() email!: string;
  @IsIn(['admin', 'editor', 'agent', 'viewer']) role!: Exclude<Role, 'owner'>;
}
