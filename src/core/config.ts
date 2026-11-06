import { join } from 'node:path';
import { loadConfig } from '@android-kit/schema';

export interface BackendConfig {
  supabaseDir?: string;
}

export const backendSchema = {
  properties: { supabaseDir: { type: 'string', minLength: 1 } },
};

export async function readBackendConfig(root: string): Promise<BackendConfig> {
  try {
    return (
      (await loadConfig<BackendConfig>(join(root, 'android-kit.yaml'), {
        name: 'backend',
        schema: backendSchema,
      })) ?? {}
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}
