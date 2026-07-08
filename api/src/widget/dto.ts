import { IsObject } from 'class-validator';

export class SaveThemeDto {
  @IsObject() theme!: Record<string, unknown>;
}
