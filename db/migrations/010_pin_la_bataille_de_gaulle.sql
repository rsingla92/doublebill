begin;

-- Cinéma Beaubien prints the two-part film as "La Bataille de Gaulle (Partie 1)" and
-- "(Partie 2)"; TMDB lists the parts under their subtitles, "L'âge de fer" (1165366)
-- and "J'écris ton nom" (1165369), so no search settles them. Titles are compared
-- case- and punctuation-insensitively, so one spelling per wording is enough.
insert into public.title_overrides (theatre_slug, title, tmdb_id, note) values
  ('*', 'La Bataille de Gaulle (Partie 1)', 1165366, '2026, Baudry; part one, L''âge de fer'),
  ('*', 'La Bataille de Gaulle (Part 1)', 1165366, '2026, Baudry; part one, L''âge de fer'),
  ('*', 'La Bataille de Gaulle : L''âge de fer', 1165366, '2026, Baudry; part one'),
  ('*', 'La Bataille de Gaulle (Partie 2)', 1165369, '2026, Baudry; part two, J''écris ton nom'),
  ('*', 'La Bataille de Gaulle (Part 2)', 1165369, '2026, Baudry; part two, J''écris ton nom'),
  ('*', 'La Bataille de Gaulle : J''écris ton nom', 1165369, '2026, Baudry; part two')
on conflict (theatre_slug, title) do nothing;

commit;
