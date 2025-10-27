USE quiz_db;

TRUNCATE TABLE question;

INSERT INTO question (theme, questionText, response1, response2, response3, response4, correctResponse) VALUES
('Histoire', 'En quelle année a eu lieu la Révolution française ?', '1787', '1789', '1792', '1795', 2),

('Science', 'Quelle est la vitesse de la lumière dans le vide ?', '299 792 458 m/s', '300 000 000 m/s', '250 000 000 m/s', '350 000 000 m/s', 1),

('Géographie', 'Quelle est la capitale du Canada ?', 'Toronto', 'Montréal', 'Ottawa', 'Vancouver', 3),

('Littérature', 'Qui a écrit "Les Misérables" ?', 'Émile Zola', 'Victor Hugo', 'Gustave Flaubert', 'Alexandre Dumas', 2),

('Cinéma', 'Dans quel film Tom Hanks joue-t-il Forrest Gump ?', 'Le Terminal', 'Forrest Gump', 'À la poursuite d\'Octobre Rouge', 'Philadelphia', 2),

('Informatique', 'Qu\'est-ce que HTTP signifie ?', 'HyperText Transfer Protocol', 'High Transfer Text Protocol', 'HyperTransfer Text Protocol', 'HyperText Transfer Process', 1),

('Sport', 'Combien de joueurs y a-t-il dans une équipe de football sur le terrain ?', '10', '11', '12', '9', 2),

('Musique', 'Quel groupe britannique est connu pour la chanson "Bohemian Rhapsody" ?', 'The Beatles', 'The Rolling Stones', 'Queen', 'Pink Floyd', 3),

('Biologie', 'Combien de cœurs a une pieuvre ?', '1', '2', '3', '4', 3),

('Histoire', 'Quand a eu lieu la Première Guerre mondiale ?', '1912-1916', '1914-1918', '1915-1919', '1916-1920', 2),

('Astronomie', 'Quelle est la plus grande planète du système solaire ?', 'Saturne', 'Jupiter', 'Uranus', 'Neptune', 2),

('Géographie', 'Quel est le plus grand océan du monde ?', 'Atlantique', 'Indien', 'Pacifique', 'Arctique', 3),

('Mathématiques', 'Quel est le résultat de 15 x 7 ?', '100', '95', '105', '110', 3),

('Arts', 'Qui a peint "La Nuit étoilée" ?', 'Pablo Picasso', 'Vincent van Gogh', 'Claude Monet', 'Leonardo da Vinci', 2),

('Histoire', 'Quel événement a marqué le début du XXe siècle ?', 'La Révolution russe', 'La Première Guerre mondiale', 'La Révolution française', 'La Seconde Guerre mondiale', 2),

('Science', 'Quelle est la formule chimique de l\'eau ?', 'H2O2', 'H2O', 'HO', 'H2O3', 2),

('Culture générale', 'Combien de continents y a-t-il sur Terre ?', '5', '6', '7', '8', 3),

('Histoire', 'Qui a découvert l\'Amérique ?', 'Vasco de Gama', 'Christophe Colomb', 'Marco Polo', 'Amerigo Vespucci', 2),

('Science', 'Quel est l\'élément chimique le plus abondant dans l\'univers ?', 'Hélium', 'Oxygène', 'Hydrogène', 'Carbone', 3),

('Géographie', 'Quel est le plus grand désert du monde ?', 'Sahara', 'Gobi', 'Antarctique', 'Désert d\'Arabie', 3);

-- Afficher le nombre de questions insérées
SELECT COUNT(*) as nombre_de_questions FROM question;
