-- Remove the retired local diagnostic store. Historical migrations stay
-- versioned; this migration removes their resulting schema and objects.
drop schema if exists workbench cascade;
