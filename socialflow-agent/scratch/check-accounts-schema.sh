#!/bin/bash
sudo -u postgres psql -d socialflow -Atc "SELECT column_name FROM information_schema.columns WHERE table_name='accounts' ORDER BY ordinal_position"
