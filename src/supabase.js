import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const supabaseConfigured = Boolean(url && key && !url.includes('YOUR_PROJECT'));
export const supabase = supabaseConfigured ? createClient(url, key) : null;
