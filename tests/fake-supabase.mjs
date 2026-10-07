// A small in-memory fake of the parts of supabase-js that Finora uses. It enforces what RLS enforces on the
// real server (a user only sees their own rows) so client logic can be tested without a network.
export function createFakeSupabase({ user = { id: 'user-1', email: 'me@example.com' }, signedIn = true } = {}) {
  const state = {
    session: signedIn ? { user, access_token: 'jwt' } : null,
    tables: { sync_profiles: [] },
    calls: { signInWithOAuth: [], signOut: 0 },
    listeners: new Set(),
  };
  const mine = (rows) => rows.filter((r) => r.user_id === state.session?.user.id);

  const client = {
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      signInWithOAuth: async (args) => { state.calls.signInWithOAuth.push(args); return { error: null }; },
      signOut: async () => { state.calls.signOut++; state.session = null; state.listeners.forEach((f) => f('SIGNED_OUT', null)); return { error: null }; },
      onAuthStateChange: (cb) => { state.listeners.add(cb); return { data: { subscription: { unsubscribe: () => state.listeners.delete(cb) } } }; },
    },
    from: (table) => ({
      select: () => ({ maybeSingle: async () => ({ data: mine(state.tables[table])[0] || null, error: null }) }),
      insert: async (row) => {
        if (!state.session) return { error: { message: 'not signed in' } };
        if (table === 'sync_profiles' && mine(state.tables[table]).length) return { error: { message: 'duplicate key value violates unique constraint' } };
        state.tables[table].push({ ...row, user_id: state.session.user.id });
        return { error: null };
      },
    }),
  };
  return { client, state, createClient: () => client };
}
