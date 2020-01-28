all:
	rm -f riot-compact.xpi
	zip -9 riot-compact.xpi manifest.json style.css

i: all
	open -a FirefoxNightly riot-compact.xpi

ia: all
	open -a FirefoxAurora riot-compact.xpi
