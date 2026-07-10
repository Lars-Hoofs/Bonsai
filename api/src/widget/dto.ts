import { IsIn, IsObject } from 'class-validator';
import { BUILT_IN_PRESETS } from './presets';
import type { PresetName } from './presets';

export class SaveThemeDto {
  @IsObject() theme!: Record<string, unknown>;
}

export class ImportThemeDto {
  @IsObject() theme!: Record<string, unknown>;
}

const PRESET_NAMES = Object.keys(BUILT_IN_PRESETS) as PresetName[];

export class ApplyPresetDto {
  @IsIn(PRESET_NAMES) preset!: PresetName;
}
