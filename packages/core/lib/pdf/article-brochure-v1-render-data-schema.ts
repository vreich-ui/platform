/**
 * `article_brochure_v1`'s `renderDataSchema`, mirrored into platform (T2.1).
 *
 * SOURCE OF TRUTH is pdf-tool's own `templates/article_brochure_v1.json` —
 * this is a verbatim mirror of that file's `renderDataSchema` node, generated
 * from it, not retyped. It exists here for exactly two reasons, both of which
 * need the contract available with no network and no pdf-tool round trip:
 *
 *  1. `render-data-mapper.ts` reads its LIMITS (section/paragraph caps, string
 *     maxLengths, the `assetId` pattern) so the data it emits satisfies W1's
 *     `RENDER_DATA_INVALID` check on the first try. When a caller supplies a
 *     real template schema, that one wins — this is only the default target,
 *     read through the same code path, so the two cannot drift.
 *  2. The mapper's tests validate their output against it for real.
 *
 * It is a MIRROR, never an authority: nothing here decides what the template
 * accepts. If pdf-tool's template changes, this file is regenerated from it.
 * Do not hand-edit, and do not add platform-only fields to it.
 */
export const ARTICLE_BROCHURE_V1_TEMPLATE_ID = 'article_brochure_v1';

export const ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://pdf-tool.internal/schemas/article_brochure_v1.render-data.json',
  title: 'article_brochure_v1 render data',
  type: 'object',
  additionalProperties: false,
  required: ['brand', 'title', 'deck', 'sections', 'pullQuotes', 'sources'],
  properties: {
    brand: {
      $ref: '#/$defs/brand',
    },
    title: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
    },
    deck: {
      type: 'string',
      minLength: 1,
      maxLength: 400,
    },
    kicker: {
      type: 'string',
      minLength: 1,
      maxLength: 80,
    },
    author: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
    },
    date: {
      type: 'string',
      minLength: 1,
      maxLength: 40,
    },
    coverImage: {
      $ref: '#/$defs/assetId',
    },
    sections: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      items: {
        $ref: '#/$defs/section',
      },
    },
    pullQuotes: {
      type: 'array',
      maxItems: 12,
      items: {
        $ref: '#/$defs/pullQuote',
      },
    },
    sources: {
      type: 'array',
      maxItems: 40,
      items: {
        $ref: '#/$defs/source',
      },
    },
    footerNote: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
    },
    disclaimer: {
      type: 'string',
      minLength: 1,
      maxLength: 600,
    },
  },
  $defs: {
    assetId: {
      type: 'string',
      pattern: '^[a-zA-Z0-9._-]{1,128}$',
    },
    brand: {
      type: 'object',
      additionalProperties: false,
      required: ['colors', 'fonts'],
      properties: {
        colors: {
          type: 'object',
          minProperties: 1,
          additionalProperties: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
          },
        },
        fonts: {
          type: 'object',
          additionalProperties: false,
          required: ['sans', 'serif', 'heading'],
          properties: {
            sans: {
              type: 'string',
              minLength: 1,
              maxLength: 80,
            },
            serif: {
              type: 'string',
              minLength: 1,
              maxLength: 80,
            },
            heading: {
              type: 'string',
              minLength: 1,
              maxLength: 80,
            },
            mono: {
              type: 'string',
              minLength: 1,
              maxLength: 80,
            },
          },
        },
        logo: {
          $ref: '#/$defs/assetId',
        },
      },
    },
    section: {
      type: 'object',
      additionalProperties: false,
      required: ['heading', 'paragraphs'],
      properties: {
        heading: {
          type: 'string',
          minLength: 1,
          maxLength: 150,
        },
        paragraphs: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
          },
        },
        figure: {
          type: 'object',
          additionalProperties: false,
          required: ['assetId'],
          properties: {
            assetId: {
              $ref: '#/$defs/assetId',
            },
            caption: {
              type: 'string',
              minLength: 1,
              maxLength: 300,
            },
          },
        },
      },
    },
    pullQuote: {
      type: 'object',
      additionalProperties: false,
      required: ['quote'],
      properties: {
        quote: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
        },
        attribution: {
          type: 'string',
          minLength: 1,
          maxLength: 150,
        },
      },
    },
    source: {
      type: 'object',
      additionalProperties: false,
      required: ['label'],
      properties: {
        label: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
        },
        url: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
        },
        note: {
          type: 'string',
          minLength: 1,
          maxLength: 300,
        },
      },
    },
  },
};
