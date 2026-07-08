import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Db, DB } from '../db/db.module';
import { users } from '../db/schema';
import { VerifiedClaims } from './oidc.verifier';

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async upsertFromClaims(
    claims: VerifiedClaims,
  ): Promise<{ id: string; email: string }> {
    const [row] = await this.db
      .insert(users)
      .values({
        oidcSubject: claims.sub,
        email: claims.email,
        name: claims.name,
      })
      .onConflictDoUpdate({
        target: users.oidcSubject,
        set: {
          email: claims.email,
          name: sql`COALESCE(EXCLUDED.name, users.name)`,
        },
      })
      .returning();
    return { id: row.id, email: row.email };
  }
}
