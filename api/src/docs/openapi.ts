import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/**
 * Builds the OpenAPI document for the whole API. Reused by the runtime docs
 * setup (main.ts) and by tests, so the spec is verified the same way it ships.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Bonsai API')
    .setDescription(
      'Multi-tenant AI customer-service chatbot platform. All endpoints are ' +
        'under the `/v1` prefix. Authenticate with a Bearer JWT (dashboard) or ' +
        'a project API key. Answers are strictly grounded in the knowledge base ' +
        'with confidence gating and citations.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addServer('https://chat.bonsaimedia.nl', 'Production')
    .addServer('http://localhost:3000', 'Local')
    .addTag('tenants', 'Tenants, members and roles')
    .addTag('projects', 'Projects within a tenant')
    .addTag('knowledge', 'Knowledge sources, documents and ingestion')
    .addTag('rag', 'Grounded answering')
    .addTag('conversations', 'Conversations and human handover')
    .addTag('widget', 'Widget theme and public delivery')
    .addTag('analytics', 'Analytics and unanswered questions')
    .addTag('webhooks', 'Developer webhooks')
    .addTag('usage', 'Usage and quota')
    .build();
  return SwaggerModule.createDocument(app, config);
}
