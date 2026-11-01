-- Aggiornamento automatico dei DDT attesi (fatture dal 2021) due volte al giorno, dopo l'import delle fatture.
-- La funzione ddt-ricevuti accetta il lasciapassare monouso di cron_chiama_funzione (header x-cron-nonce).
select cron.schedule('ddt-attesi-aggiorna', '50 5,13 * * *',
  $$select public.cron_chiama_funzione('DDT attesi','ddt-ricevuti','{"azione":"aggiorna_attesi"}'::jsonb)$$);
