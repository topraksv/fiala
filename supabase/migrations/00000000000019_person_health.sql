-- A person's allergies and the conditions they live with, in their own words,
-- for the emergency card (docs/TASKS.md F7.7). Free text, as a box's note is:
-- nothing reads them but the people of the cabinet, and nothing infers from
-- them. Bounded like every other text column, so a crafted backup cannot
-- park a megabyte in a row.

begin;

alter table public.people
  add column allergies text check (char_length(allergies) between 1 and 500),
  add column conditions text check (char_length(conditions) between 1 and 500);

commit;
