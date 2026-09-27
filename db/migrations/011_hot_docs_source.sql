begin;

-- The Hot Docs Ted Rogers Cinema now has an extractor: the Agile Ticketing feed on
-- boxoffice.hotdocs.ca. Its programme is first-run documentaries, so of two
-- same-title films the current one wins. TIFF Lightbox stays without a
-- programme: it mixes first-run with repertory, and it still has no extractor.
update public.theatres
  set ticketing_base_url = 'https://boxoffice.hotdocs.ca',
      source_kind = 'hidden_api',
      source_url = 'https://boxoffice.hotdocs.ca/websales/feed.ashx?guid=64170f3e-6ca4-4dbc-9cb5-e359273e95dd&showslist=true&format=json',
      source_config = source_config || '{"programme": "first_run"}'::jsonb,
      is_active = true
  where slug = 'hot-docs-cinema';

commit;
