-- v4 : l'echauffement guide devient le comportement par defaut.
--
-- Il etait eteint pour ne rien imposer, mais une rampe qu'il faut activer soi-
-- meme n'est pas un echauffement automatique. Le reglage reste dans Reglages
-- pour qui veut l'eteindre.
UPDATE setting SET value = '1' WHERE key = 'warmup_enabled';
